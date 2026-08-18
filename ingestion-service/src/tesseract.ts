import { spawn } from 'node:child_process';

import { ServiceError } from './errors.js';
import { normalizeOcr } from './ollama.js';
import type { PageRecognizer, RenderedPage, TextPage } from './types.js';

/**
 * Per-page ceiling. Tesseract reads a 150dpi A4 scan in well under a second, so
 * this only ever fires on a pathological page or a wedged container.
 * ponytail: hardcoded — make it an env only if a 300dpi batch ever hits it.
 */
const PAGE_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 5_000;

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
 * OCR through the `tesseract-ocr` container, driven by `docker exec -i`.
 *
 * The container publishes no ports and mounts no volumes, so exec with the page
 * bytes on stdin is the whole interface. Same shape as the pdftoppm spawn in
 * renderer.ts, and the same reason: the binary lives outside this process.
 */
export class TesseractClient implements PageRecognizer {
  constructor(
    private readonly options: {
      container: string;
      /** Tesseract language spec, e.g. `heb+eng`. Order sets the primary language. */
      langs: string;
      spawnImplementation?: typeof spawn;
    },
  ) {}

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
