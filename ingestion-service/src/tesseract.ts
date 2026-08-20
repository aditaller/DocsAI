import { spawn } from 'node:child_process';

import { ServiceError } from './errors.js';
import { normalizeOcr } from './ollama.js';
import type { OcrEngineId, PageRecognizer, RenderedPage, TextPage } from './types.js';

/**
 * Per-page ceiling. Tesseract reads a 150dpi A4 scan in well under a second, so
 * this only ever fires on a pathological page or a wedged container.
 * ponytail: hardcoded — make it an env only if a 300dpi batch ever hits it.
 */
const PAGE_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 5_000;
/** OSD classifies rather than recognises; a page it has not answered for in this long is wedged. */
const OSD_TIMEOUT_MS = 15_000;
/**
 * Tesseract's own bar for a script call worth acting on. Below it the page is
 * too sparse or too noisy to have been read at all, and acting on that guess is
 * worse than falling back.
 * ponytail: one number, taken from tesseract's documented threshold rather than
 * tuned against this corpus. Raise it if clean Hebrew scans come back Latin.
 */
const MIN_SCRIPT_CONFIDENCE = 1.5;

/** Column order of `tesseract … tsv`, which is stable across 4.x and 5.x. */
const LEVEL = 0;
const BLOCK_NUMBER = 2;
const PARAGRAPH_NUMBER = 3;
const LINE_NUMBER = 4;
const CONFIDENCE = 10;
const TEXT = 11;
/** Only level-5 rows are words; 1–4 are page/block/paragraph/line envelopes. */
const WORD_LEVEL = '5';

/**
 * Rebuilds the page text and a 0–1 score from one `tsv` run.
 *
 * TSV rather than the plain `txt` output because it is the only format that
 * carries per-word confidence, and a second pass just to read the text back
 * would double the cost of the fastest part of the pipeline. Words are joined
 * with a space and broken on (block, paragraph, line), which is how tesseract
 * itself lays out `txt`; a new block starts a blank line, since a block is a
 * separate region of the page rather than the next line of a paragraph.
 *
 * Confidence is the arithmetic mean of the word scores, unlike the vision
 * model's geometric mean of token probabilities: tesseract reports one score per
 * word rather than per token, and a single unreadable stamp in the margin should
 * not drag a clean page to zero.
 */
export function parseTesseractTsv(tsv: string): { text: string; confidence: number | null } {
  const lines: string[] = [];
  const confidences: number[] = [];
  let currentWords: string[] = [];
  let currentLine = '';
  let currentBlock = '';

  const flush = (): void => {
    if (currentWords.length) lines.push(currentWords.join(' '));
    currentWords = [];
  };

  for (const row of tsv.split('\n')) {
    const fields = row.split('\t');
    if (fields[LEVEL] !== WORD_LEVEL) continue;
    // Re-join anything past the text column: the field is last, so a tab inside
    // it would otherwise silently truncate the word.
    const word = fields.slice(TEXT).join('\t').trim();
    if (!word) continue;

    const block = fields[BLOCK_NUMBER] ?? '';
    const line = `${block}/${fields[PARAGRAPH_NUMBER]}/${fields[LINE_NUMBER]}`;
    if (line !== currentLine) {
      flush();
      if (currentBlock && block !== currentBlock) lines.push('');
      currentLine = line;
      currentBlock = block;
    }
    currentWords.push(word);

    // -1 marks a row tesseract could not score; counting it as zero would report
    // a clean page as unreadable.
    const confidence = Number(fields[CONFIDENCE]);
    if (Number.isFinite(confidence) && confidence >= 0) confidences.push(confidence);
  }
  flush();

  return {
    text: normalizeOcr(lines.join('\n')),
    confidence: confidences.length ? confidences.reduce((total, value) => total + value, 0) / confidences.length / 100 : null,
  };
}

/**
 * Names the script the page is written in.
 *
 * Tesseract emits no language label — it is told which languages to load rather
 * than reporting what it found — so the `Language:` line `detectLanguage` reads
 * off the vision model has no counterpart here. This is the same Hebrew-block
 * test the results panel already uses to decide text direction.
 */
export function detectScript(text: string): string | null {
  if (!text.trim()) return null;
  return /[֐-׿]/.test(text) ? 'Hebrew' : 'English';
}

/**
 * A recognizer that can name the language spec it ran with, so the ingest
 * response can report what actually read the pages. Fixed for a client built
 * around one language set, and null on an auto client until it has seen a page.
 */
export interface TesseractRecognizer extends PageRecognizer {
  readonly langs: string | null;
}

/**
 * OCR through the `tesseract-ocr` container, driven by `docker exec -i`.
 *
 * The container publishes no ports and mounts no volumes, so exec with the page
 * bytes on stdin is the whole interface. Same shape as the pdftoppm spawn in
 * renderer.ts, and the same reason: the binary lives outside this process.
 */
export class TesseractClient implements TesseractRecognizer {
  constructor(
    private readonly options: {
      container: string;
      /** Tesseract language spec, e.g. `heb+eng`. Order sets the primary language. */
      langs: string;
      spawnImplementation?: typeof spawn;
    },
  ) {}

  get langs(): string {
    return this.options.langs;
  }

  async recognizePage(page: RenderedPage): Promise<TextPage> {
    const tsv = await this.run(
      ['exec', '-i', this.options.container, 'tesseract', 'stdin', 'stdout', '-l', this.options.langs, 'tsv'],
      page.bytes,
      PAGE_TIMEOUT_MS,
    );
    const { text, confidence } = parseTesseractTsv(tsv);
    if (!text) {
      throw new ServiceError(
        `Tesseract returned no text for page ${page.pageIndex}. A page that truly has no text aside, this usually means ` +
          'the scan is too low-resolution for the language models loaded — raise PDF_RENDER_DPI, or check TESSERACT_LANGS.',
        'renderer',
        false,
      );
    }
    return { pageIndex: page.pageIndex, text, confidence };
  }

  /**
   * The script OSD reads off this page, or null when it declined to say.
   *
   * `--psm 0` runs orientation-and-script detection only — no recognition — so
   * this costs one process start (~0.5s through `docker exec`) instead of a full
   * OCR pass. `-l osd` overrides whatever language set this client was built
   * with, so either client can answer.
   *
   * Null covers every way OSD declines rather than fails: a page with too little
   * text exits non-zero with "Too few characters", and a noisy scan answers with
   * a confidence too low to act on. Both mean "you choose", not "this broke", so
   * neither throws — the caller has a language set to fall back to either way.
   */
  async detectPageScript(page: RenderedPage): Promise<string | null> {
    let output: string;
    try {
      output = await this.run(
        ['exec', '-i', this.options.container, 'tesseract', 'stdin', 'stdout', '--psm', '0', '-l', 'osd'],
        page.bytes,
        OSD_TIMEOUT_MS,
      );
    } catch {
      return null;
    }
    const confidence = Number(/^Script confidence:[ \t]*(\S+)$/m.exec(output)?.[1]);
    if (Number.isFinite(confidence) && confidence < MIN_SCRIPT_CONFIDENCE) return null;
    return /^Script:[ \t]*(.+)$/m.exec(output)?.[1]?.trim() || null;
  }

  /** Health probe: proves the container is up and tesseract is on its PATH. */
  async version(): Promise<string> {
    const output = await this.run(['exec', this.options.container, 'tesseract', '--version'], null, VERSION_TIMEOUT_MS);
    return output.split('\n')[0]?.trim() ?? '';
  }

  private run(args: string[], input: Buffer | null, timeoutMs: number): Promise<string> {
    const spawnProcess = this.options.spawnImplementation ?? spawn;
    return new Promise((resolve, reject) => {
      const child = spawnProcess('docker', args, {
        shell: false,
        windowsHide: true,
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new ServiceError(`Tesseract timed out after ${timeoutMs}ms`, 'renderer', true));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(0, 500);
      });
      child.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(new ServiceError(`Could not run docker: ${error.message}`, 'renderer', false));
      });
      child.once('close', (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
        else reject(new ServiceError(`Tesseract exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`, 'renderer', false));
      });

      if (input) {
        // A container that died mid-write hangs up the pipe; the close handler
        // above already reports the real reason, so this must not throw over it.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(input);
      }
    });
  }
}

/**
 * Reads the script off page 1, then runs the whole document with the matching
 * language set.
 *
 * The alternative is what the engine list did before this existed: have the
 * operator name the language. That is right when they know the corpus and wrong
 * the moment a mixed folder is dropped in, and loading `heb` for a Latin page
 * measurably hurts it. One OSD pass costs about half a second per document
 * against seconds per page of OCR, so detecting is close to free next to the
 * work it steers.
 *
 * The chosen client is remembered so pages 2..n do not each pay for detection,
 * and re-chosen on page 1 because that is where the next document begins — the
 * batch CLI ingests strictly serially (pipeline.ts) and shares one instance,
 * where the HTTP server builds a fresh one per request so two concurrent
 * uploads cannot read each other's language.
 */
export class AutoTesseractClient implements TesseractRecognizer {
  private delegate: TesseractClient | null = null;

  constructor(private readonly options: { hebrew: TesseractClient; latin: TesseractClient }) {}

  /** The spec that actually ran, or null before the first page has been read. */
  get langs(): string | null {
    return this.delegate?.langs ?? null;
  }

  async recognizePage(page: RenderedPage): Promise<TextPage> {
    if (page.pageIndex === 1 || !this.delegate) this.delegate = await this.choose(page);
    return this.delegate.recognizePage(page);
  }

  /**
   * Hebrew unless OSD is confident the page is something else.
   *
   * The trade is deliberately lopsided: the Hebrew set is `heb+eng`, so it still
   * reads a Latin page — worse than `eng` would, but it reads it — where `eng`
   * on a Hebrew page returns nothing usable at all. An unsure OSD therefore gets
   * the recoverable half.
   */
  private async choose(page: RenderedPage): Promise<TesseractClient> {
    const script = await this.options.hebrew.detectPageScript(page);
    return script && script !== 'Hebrew' ? this.options.latin : this.options.hebrew;
  }
}

/**
 * The recognizer one tesseract engine id names.
 *
 * Here rather than repeated at the call sites (the HTTP default, the per-request
 * override, the batch CLI) because only this file knows that `tesseract-auto`
 * has to be built fresh per ingest while the others are stateless and could be
 * shared. Callers get a new one every time and need not know which is which.
 */
export function createTesseractRecognizer(
  id: Exclude<OcrEngineId, 'ollama' | 'azure-layout'>,
  options: { container: string; langs: Record<'tesseract-heb' | 'tesseract-eng', string> },
): TesseractRecognizer {
  const client = (langs: string): TesseractClient => new TesseractClient({ container: options.container, langs });
  if (id !== 'tesseract-auto') return client(options.langs[id]);
  return new AutoTesseractClient({ hebrew: client(options.langs['tesseract-heb']), latin: client(options.langs['tesseract-eng']) });
}
