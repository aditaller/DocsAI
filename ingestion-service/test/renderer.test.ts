import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';

import { ImagePageRenderer, PopplerPdfRenderer, SourceRenderer } from '../src/renderer.js';
import { ServiceError } from '../src/errors.js';
import type { SourceFile } from '../src/types.js';

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('body')]);
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

function sourceOf(bytes: Buffer): SourceFile {
  return { archiveId: 1, sourceClaimId: 2, fileName: 'f.pdf', mimeType: 'application/pdf', bytes };
}

interface SpawnRecord {
  command: string;
  args: string[];
}

interface Reply {
  stdout?: string;
  exitCode?: number;
  stderr?: string;
  /** Emit a spawn `error` instead of running — how ENOENT reaches the caller. */
  error?: Error;
  /** PNG basenames to drop next to the output prefix, standing in for a render. */
  writes?: string[];
}

/**
 * Stands in for the poppler binaries. The handler sees each argv and decides
 * what that invocation does, which is what lets one test drive pdftotext and
 * pdftoppm differently within a single render.
 */
function fakeSpawn(handler: (command: string, args: string[]) => Reply): {
  implementation: typeof spawn;
  calls: SpawnRecord[];
} {
  const calls: SpawnRecord[] = [];
  const implementation = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const reply = handler(command, args);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child['stdout'] = new EventEmitter();
    child['stderr'] = new EventEmitter();
    child['kill'] = () => undefined;
    setImmediate(() => {
      if (reply.error) {
        child.emit('error', reply.error);
        return;
      }
      // The real pdftoppm writes PNGs beside the prefix; the renderer reads the
      // directory back, so the stub has to leave real files there.
      for (const name of reply.writes ?? []) {
        writeFileSync(path.join(path.dirname(args[args.length - 1]!), name), Buffer.from([137, 80, 78, 71]));
      }
      if (reply.stdout) (child['stdout'] as EventEmitter).emit('data', Buffer.from(reply.stdout, 'utf8'));
      if (reply.stderr) (child['stderr'] as EventEmitter).emit('data', Buffer.from(reply.stderr, 'utf8'));
      child.emit('close', reply.exitCode ?? 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { implementation, calls };
}

function rendererWith(implementation: typeof spawn, maxPages = 100): PopplerPdfRenderer {
  return new PopplerPdfRenderer({
    executable: path.join('C:', 'poppler', 'bin', 'pdftoppm.exe'),
    maxPages,
    timeoutMs: 5_000,
    spawnImplementation: implementation,
  });
}

test('a digital PDF is read from its text layer, without rasterising anything', async () => {
  // Two pages of real text, and the trailing form feed pdftotext always writes.
  const first = 'א'.repeat(150);
  const second = 'B'.repeat(150);
  const { implementation, calls } = fakeSpawn(() => ({ stdout: `${first}\f${second}\f` }));

  const rendered = await rendererWith(implementation).render(sourceOf(PDF_BYTES));

  assert.equal(calls.length, 1, 'pdftoppm must not run when the text layer suffices');
  assert.equal(calls[0]?.command, path.join('C:', 'poppler', 'bin', 'pdftotext.exe'));
  // Latin-1 is pdftotext's default and would return mojibake for the Hebrew page.
  assert.ok(calls[0]?.args.includes('-enc') && calls[0]?.args.includes('UTF-8'));
  assert.deepEqual(rendered.pages, []);
  assert.equal(rendered.textPages?.length, 2, 'the trailing form feed is an artefact, not a third page');
  assert.deepEqual(
    rendered.textPages?.map((page) => page.pageIndex),
    [1, 2],
  );
  assert.equal(rendered.textPages?.[0]?.text, first);
  assert.equal(rendered.textPages?.[0]?.confidence, 1);
});

test('a scanned PDF falls back to rasterising every page', async () => {
  const { implementation, calls } = fakeSpawn((command) =>
    // No text layer to speak of, so the render path has to take over.
    command.endsWith('pdftotext.exe') ? { stdout: '' } : { writes: ['page-1.png', 'page-2.png'] },
  );

  const rendered = await rendererWith(implementation).render(sourceOf(PDF_BYTES));

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.command, path.join('C:', 'poppler', 'bin', 'pdftoppm.exe'));
  assert.equal(rendered.textPages, undefined);
  assert.deepEqual(
    rendered.pages.map((page) => page.pageIndex),
    [1, 2],
  );
  assert.equal(rendered.pages[0]?.mimeType, 'image/png');
});

test('a page carrying only a stray header stamp is treated as scanned', async () => {
  // The failure this guards: accepting a scan's few characters of text layer
  // would store a near-empty page instead of reading the page.
  const { implementation, calls } = fakeSpawn((command) =>
    command.endsWith('pdftotext.exe') ? { stdout: `${'x'.repeat(400)}\fSCANNED COPY\f` } : { writes: ['page-1.png'] },
  );

  const rendered = await rendererWith(implementation).render(sourceOf(PDF_BYTES));

  assert.equal(calls.length, 2, 'one weak page sends the whole document to OCR');
  assert.equal(rendered.textPages, undefined);
});

test('an over-long PDF is refused on the text path too', async () => {
  const page = `${'x'.repeat(150)}\f`;
  const { implementation } = fakeSpawn(() => ({ stdout: page.repeat(3) }));

  await assert.rejects(rendererWith(implementation, 2).render(sourceOf(PDF_BYTES)), (error: unknown) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, 'source_limit');
    return true;
  });
});

test('a missing poppler names the install and the setting', async () => {
  const { implementation } = fakeSpawn(() => ({ error: Object.assign(new Error('spawn pdftoppm ENOENT'), { code: 'ENOENT' }) }));

  await assert.rejects(rendererWith(implementation).render(sourceOf(PDF_BYTES)), (error: unknown) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.retryable, false);
    assert.match(error.message, /Poppler/);
    assert.match(error.message, /PDFTOPPM_PATH/);
    return true;
  });
});

test('version() probes the configured binary', async () => {
  const { implementation, calls } = fakeSpawn(() => ({}));

  await rendererWith(implementation).version();

  assert.deepEqual(calls[0]?.args, ['-v']);
});

test('SourceRenderer routes on the magic bytes, not the declared mime type', async () => {
  const { implementation } = fakeSpawn(() => ({ stdout: `${'x'.repeat(150)}\f` }));
  const renderer = new SourceRenderer(new ImagePageRenderer(), rendererWith(implementation));

  const asPdf = await renderer.render(sourceOf(PDF_BYTES));
  assert.equal(asPdf.sourceMimeType, 'application/pdf');

  // Declared as a PDF, actually a PNG: the sniffed type wins.
  const asImage = await renderer.render(sourceOf(PNG_BYTES));
  assert.equal(asImage.sourceMimeType, 'image/png');
  assert.equal(asImage.pages.length, 1);
});
