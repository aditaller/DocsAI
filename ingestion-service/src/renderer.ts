import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ServiceError } from './errors.js';
import type { RenderedDocument, RenderedPage, SourceFile } from './types.js';

const imageSignatures: Array<{ mimeType: RenderedPage['mimeType']; matches: (bytes: Buffer) => boolean }> = [
  { mimeType: 'image/png', matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mimeType: 'image/jpeg', matches: (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  { mimeType: 'image/gif', matches: (bytes) => bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a' },
  { mimeType: 'image/webp', matches: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' },
];

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
    private readonly options: { executable: string; maxPages: number; timeoutMs: number; tempRoot?: string },
  ) {}

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
      // Render one additional page: if it exists the source breached the limit,
      // rather than being silently truncated by pdftoppm's page range.
      await runProcess(this.options.executable, ['-f', '1', '-l', String(this.options.maxPages + 1), '-png', sourceFile, outputPrefix], this.options.timeoutMs);

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
}

export class SourceRenderer implements PageRenderer {
  constructor(private readonly imageRenderer: PageRenderer, private readonly pdfRenderer: PageRenderer) {}

  async render(source: SourceFile): Promise<RenderedDocument> {
    if (source.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return this.pdfRenderer.render(source);
    return this.imageRenderer.render(source);
  }
}

function runProcess(executable: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ServiceError('PDF renderer timed out', 'renderer', false));
    }, timeoutMs);
    child.stderr.on('data', (data: Buffer) => {
      stderr = `${stderr}${data.toString('utf8')}`.slice(0, 500);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new ServiceError(`PDF renderer could not start: ${error.message}`, 'renderer', false));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ServiceError(`PDF renderer exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`, 'renderer', false));
    });
  });
}
