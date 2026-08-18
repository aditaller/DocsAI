import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ServiceError } from './errors.js';
import type { RenderedDocument, RenderedPage, SourceFile, TextPage } from './types.js';

const imageSignatures: Array<{ mimeType: RenderedPage['mimeType']; matches: (bytes: Buffer) => boolean }> = [
  { mimeType: 'image/png', matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mimeType: 'image/jpeg', matches: (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  { mimeType: 'image/gif', matches: (bytes) => bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a' },
  { mimeType: 'image/webp', matches: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' },
];

/** Long enough for a cold binary on a busy disk, short enough not to stall /health. */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Non-whitespace characters a page's embedded text must carry before the text
 * layer is trusted for the whole document. A scanned page yields nothing or a
 * few stray characters from a header stamp; accepting those would silently
 * store an almost-empty page instead of reading it.
 * ponytail: one threshold, all-or-nothing per document. A PDF that mixes typed
 * and scanned pages therefore goes to OCR entirely, which is slow but never
 * wrong. Extract per page and raster only the failing ones (`pdftoppm -f N -l N`)
 * if mixed documents turn out to be common.
 */
const MIN_TEXT_CHARS_PER_PAGE = 100;

export interface PageRenderer {
  render(source: SourceFile): Promise<RenderedDocument>;
}

export class ImagePageRenderer implements PageRenderer {
  async render(source: SourceFile): Promise<RenderedDocument> {
    const signature = imageSignatures.find((candidate) => candidate.matches(source.bytes));
    if (!signature) throw new ServiceError('Source is not a supported image', 'unsupported_file', false);
    return {
      sourceMimeType: signature.mimeType,
      pages: [{ pageIndex: 1, mimeType: signature.mimeType, bytes: source.bytes }],
    };
  }
}

export class PopplerPdfRenderer implements PageRenderer {
  constructor(
    private readonly options: {
      executable: string;
      maxPages: number;
      timeoutMs: number;
      dpi?: number;
      tempRoot?: string;
      spawnImplementation?: typeof spawn;
    },
  ) {}

  /**
   * Health probe: proves the binary exists and runs. Same role as
   * TesseractClient.version(), and the same reason — a missing external binary
   * should surface on the health banner, not on someone's first PDF upload.
   * ponytail: exit code only. `-v` writes the version to stderr, which
   * runProcess deliberately keeps for error messages rather than returning.
   */
  async version(): Promise<void> {
    await runProcess(this.options.executable, ['-v'], VERSION_TIMEOUT_MS, this.options.spawnImplementation);
  }

  async render(source: SourceFile): Promise<RenderedDocument> {
    if (!source.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new ServiceError('Source is not a PDF', 'unsupported_file', false);
    }
    const root = this.options.tempRoot ?? os.tmpdir();
    const workDir = await fs.mkdtemp(path.join(root, 'rag-ingestion-'));
    try {
      const sourceFile = path.join(workDir, `${randomUUID()}.pdf`);
      const outputPrefix = path.join(workDir, 'page');
      await fs.writeFile(sourceFile, source.bytes, { mode: 0o600 });

      // A digital PDF already carries its text. Lifting it is exact and takes
      // milliseconds, where rasterising every page and running OCR over it takes
      // seconds per page and only approximates what is already there.
      const textPages = await this.extractTextLayer(sourceFile);
      if (textPages) return { sourceMimeType: 'application/pdf', pages: [], textPages };

      // Render one additional page: if it exists the source breached the limit,
      // rather than being silently truncated by pdftoppm's page range.
      // Resolution is the one lever that matters to tesseract: it reads a 300dpi
      // render of a Hebrew scan far better than poppler's 150dpi default.
      const resolution = this.options.dpi ? ['-r', String(this.options.dpi)] : [];
      await runProcess(
        this.options.executable,
        ['-f', '1', '-l', String(this.options.maxPages + 1), ...resolution, '-png', sourceFile, outputPrefix],
        this.options.timeoutMs,
        this.options.spawnImplementation,
      );

      const outputFiles = (await fs.readdir(workDir))
        .filter((name) => /^page-\d+\.png$/i.test(name))
        .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
      if (outputFiles.length === 0) throw new ServiceError('PDF renderer returned no pages', 'renderer', false);
      if (outputFiles.length > this.options.maxPages) throw new ServiceError('PDF exceeds configured page limit', 'source_limit', false);
      const pages: RenderedPage[] = await Promise.all(
        outputFiles.map(async (name, offset) => ({
          pageIndex: offset + 1,
          mimeType: 'image/png',
          bytes: await fs.readFile(path.join(workDir, name)),
        })),
      );
      return { sourceMimeType: 'application/pdf', pages };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * The document's own text layer, or null when it has to be read as an image.
   * Null covers both a scanned PDF and a pdftotext that would not run at all —
   * either way the answer is "raster it", so a missing pdftotext degrades to the
   * previous behaviour rather than failing the ingest.
   */
  private async extractTextLayer(sourceFile: string): Promise<TextPage[] | null> {
    const executable = siblingExecutable(this.options.executable, 'pdftotext');
    let output: string;
    try {
      output = await runProcess(
        executable,
        // -enc UTF-8 is not optional: pdftotext defaults to Latin-1 and would
        // return mojibake for every Hebrew document this service exists to read.
        // -layout keeps columns and table cells apart, which matters for forms.
        ['-enc', 'UTF-8', '-layout', '-f', '1', '-l', String(this.options.maxPages + 1), sourceFile, '-'],
        this.options.timeoutMs,
        this.options.spawnImplementation,
      );
    } catch {
      return null;
    }

    // pdftotext writes a form feed after every page, including the last, so the
    // split always leaves one trailing empty entry that is an artefact rather
    // than a blank page. Dropping exactly one keeps a genuinely blank final page.
    const pageTexts = output.split('\f');
    if (pageTexts.length > 1 && pageTexts[pageTexts.length - 1] === '') pageTexts.pop();
    if (pageTexts.length === 0) return null;
    // Checked here as well as on the raster path: an over-long PDF must be
    // refused the same way whether or not it happens to be digital.
    if (pageTexts.length > this.options.maxPages) throw new ServiceError('PDF exceeds configured page limit', 'source_limit', false);

    const digital = pageTexts.every((text) => text.replace(/\s/gu, '').length >= MIN_TEXT_CHARS_PER_PAGE);
    if (!digital) return null;
    // confidence 1: this is the document's own text, copied out, not recognised.
    return pageTexts.map((text, offset) => ({ pageIndex: offset + 1, text: text.trim(), confidence: 1 }));
  }
}

/**
 * Poppler's tools ship in one directory, so pdftotext sits next to the
 * configured pdftoppm. Deriving it beats a second env var that could only ever
 * disagree with the first. A bare name on PATH stays a bare name.
 */
function siblingExecutable(executable: string, name: string): string {
  const directory = path.dirname(executable);
  const extension = path.extname(executable);
  return directory === '.' ? `${name}${extension}` : path.join(directory, `${name}${extension}`);
}

export class SourceRenderer implements PageRenderer {
  constructor(private readonly imageRenderer: PageRenderer, private readonly pdfRenderer: PageRenderer) {}

  async render(source: SourceFile): Promise<RenderedDocument> {
    if (source.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return this.pdfRenderer.render(source);
    return this.imageRenderer.render(source);
  }
}

/** Resolves with stdout: pdftoppm and `-v` have none, pdftotext returns the text there. */
function runProcess(executable: string, args: string[], timeoutMs: number, spawnImplementation?: typeof spawn): Promise<string> {
  const spawnProcess = spawnImplementation ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ServiceError('PDF renderer timed out', 'renderer', false));
    }, timeoutMs);
    child.stdout?.on('data', (data: Buffer) => stdout.push(data));
    child.stderr?.on('data', (data: Buffer) => {
      stderr = `${stderr}${data.toString('utf8')}`.slice(0, 500);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      // A bare `spawn pdftoppm` reads like a bug in this service; it is almost
      // always a host that never had Poppler. Name the fix in the message.
      reject(
        new ServiceError(
          `PDF renderer could not start: ${error.message}. Install Poppler ` +
            '(winget install --id oschwartz10612.Poppler) and point PDFTOPPM_PATH at its pdftoppm executable.',
          'renderer',
          false,
        ),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new ServiceError(`PDF renderer exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`, 'renderer', false));
    });
  });
}
