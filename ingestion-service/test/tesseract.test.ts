import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ServiceError } from '../src/errors.js';
import { AutoTesseractClient, detectScript, parseTesseractTsv, TesseractClient } from '../src/tesseract.js';

const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

/** `level, page, block, par, line, word` then five geometry columns, conf, text. */
function word(block: number, paragraph: number, line: number, index: number, confidence: number, text: string): string {
  return ['5', '1', block, paragraph, line, index, 0, 0, 10, 10, confidence, text].join('\t');
}

const PAGE = [
  HEADER,
  '1\t1\t0\t0\t0\t0\t0\t0\t600\t800\t-1\t',
  '2\t1\t1\t0\t0\t0\t10\t10\t500\t100\t-1\t',
  '4\t1\t1\t1\t1\t0\t10\t10\t500\t40\t-1\t',
  word(1, 1, 1, 1, 96.5, 'שלום'),
  word(1, 1, 1, 2, 88.5, 'עולם'),
  word(1, 1, 2, 1, -1, '~~'),
  word(1, 1, 2, 2, 70, 'Ltd.'),
  word(2, 1, 1, 1, 50, 'Total'),
].join('\n');

test('parseTesseractTsv joins words into lines and separates blocks', () => {
  const { text } = parseTesseractTsv(PAGE);
  assert.equal(text, 'שלום עולם\n~~ Ltd.\n\nTotal');
});

test('parseTesseractTsv averages word confidence, skipping unscored words', () => {
  const { confidence } = parseTesseractTsv(PAGE);
  // (96.5 + 88.5 + 70 + 50) / 4 / 100 — the conf:-1 word contributes its text but no score.
  assert.equal(confidence, 0.7625);
});

test('parseTesseractTsv reports no score rather than zero when nothing was scored', () => {
  const { text, confidence } = parseTesseractTsv([HEADER, word(1, 1, 1, 1, -1, 'illegible')].join('\n'));
  assert.equal(text, 'illegible');
  assert.equal(confidence, null);
});

test('parseTesseractTsv returns empty text for a page with no words', () => {
  const { text, confidence } = parseTesseractTsv(HEADER);
  assert.equal(text, '');
  assert.equal(confidence, null);
});

test('detectScript names the script, and nothing for an empty page', () => {
  assert.equal(detectScript('שלום עולם'), 'Hebrew');
  assert.equal(detectScript('Total due'), 'English');
  assert.equal(detectScript('   '), null);
});

interface SpawnRecord {
  command: string;
  args: string[];
  stdin: Buffer[];
}

interface Run {
  stdout?: string;
  exitCode?: number;
  stderr?: string;
}

/**
 * Stands in for `docker`: records the argv and stdin, then replays the canned
 * runs in order. The last one repeats, so a single-run list behaves like a fixed
 * response for the tests that only ever exec once.
 */
function fakeSpawnRuns(runs: Run[]): { implementation: typeof spawn; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  const implementation = ((command: string, args: string[]) => {
    const call: SpawnRecord = { command, args, stdin: [] };
    const run = runs[Math.min(calls.length, runs.length - 1)] ?? {};
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child['stdout'] = new EventEmitter();
    child['stderr'] = new EventEmitter();
    child['stdin'] = Object.assign(new EventEmitter(), { end: (bytes: Buffer) => call.stdin.push(bytes) });
    setImmediate(() => {
      if (run.stdout) (child['stdout'] as EventEmitter).emit('data', Buffer.from(run.stdout, 'utf8'));
      if (run.stderr) (child['stderr'] as EventEmitter).emit('data', Buffer.from(run.stderr, 'utf8'));
      child.emit('close', run.exitCode ?? 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { implementation, calls };
}

function fakeSpawn(stdout: string, exitCode = 0, stderr = ''): { implementation: typeof spawn; calls: SpawnRecord[] } {
  return fakeSpawnRuns([{ stdout, exitCode, stderr }]);
}

test('TesseractClient execs the container with the page on stdin', async () => {
  const { implementation, calls } = fakeSpawn(PAGE);
  const bytes = Buffer.from([137, 80, 78, 71]);
  const client = new TesseractClient({ container: 'tesseract-ocr', langs: 'heb+eng', spawnImplementation: implementation });

  const page = await client.recognizePage({ pageIndex: 3, mimeType: 'image/png', bytes });

  assert.equal(calls[0]?.command, 'docker');
  assert.deepEqual(calls[0]?.args, ['exec', '-i', 'tesseract-ocr', 'tesseract', 'stdin', 'stdout', '-l', 'heb+eng', 'tsv']);
  assert.deepEqual(calls[0]?.stdin, [bytes]);
  assert.equal(page.pageIndex, 3);
  assert.equal(page.text, 'שלום עולם\n~~ Ltd.\n\nTotal');
  assert.equal(page.confidence, 0.7625);
});

test('TesseractClient surfaces a failed exec as a non-retryable error', async () => {
  const { implementation } = fakeSpawn('', 1, 'Error opening data file heb.traineddata');
  const client = new TesseractClient({ container: 'tesseract-ocr', langs: 'heb', spawnImplementation: implementation });

  await assert.rejects(
    client.recognizePage({ pageIndex: 1, mimeType: 'image/png', bytes: Buffer.from([1]) }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.retryable, false);
      assert.match(error.message, /heb\.traineddata/);
      return true;
    },
  );
});

test('TesseractClient reports an empty transcription instead of storing a blank page', async () => {
  const { implementation } = fakeSpawn(HEADER);
  const client = new TesseractClient({ container: 'tesseract-ocr', langs: 'heb+eng', spawnImplementation: implementation });

  await assert.rejects(
    client.recognizePage({ pageIndex: 2, mimeType: 'image/png', bytes: Buffer.from([1]) }),
    /no text for page 2/,
  );
});

/** What `tesseract stdin stdout --psm 0 -l osd` writes for a page it could call. */
function osd(script: string, confidence = 12.5): string {
  return ['Page number: 0', 'Orientation in degrees: 0', 'Rotate: 0', 'Orientation confidence: 7.5', `Script: ${script}`, `Script confidence: ${confidence}`].join('\n');
}

const OSD_ARGS = ['exec', '-i', 'tesseract-ocr', 'tesseract', 'stdin', 'stdout', '--psm', '0', '-l', 'osd'];

/** The pair AutoTesseractClient chooses between, sharing one fake docker. */
function autoClient(implementation: typeof spawn): AutoTesseractClient {
  return new AutoTesseractClient({
    hebrew: new TesseractClient({ container: 'tesseract-ocr', langs: 'heb+eng', spawnImplementation: implementation }),
    latin: new TesseractClient({ container: 'tesseract-ocr', langs: 'eng', spawnImplementation: implementation }),
  });
}

function page(pageIndex: number): { pageIndex: number; mimeType: 'image/png'; bytes: Buffer } {
  return { pageIndex, mimeType: 'image/png', bytes: Buffer.from([137, 80, 78, 71]) };
}

test('detectPageScript asks for OSD only, and reads the script back', async () => {
  const { implementation, calls } = fakeSpawn(osd('Hebrew'));
  const client = new TesseractClient({ container: 'tesseract-ocr', langs: 'heb+eng', spawnImplementation: implementation });

  assert.equal(await client.detectPageScript(page(1)), 'Hebrew');
  assert.deepEqual(calls[0]?.args, OSD_ARGS);
});

test('detectPageScript declines rather than throwing when OSD gives up on the page', async () => {
  // The real failure on a page with too little text: non-zero exit, no Script line.
  const { implementation } = fakeSpawn('', 1, 'Too few characters. Skipping this page');
  const client = new TesseractClient({ container: 'tesseract-ocr', langs: 'heb+eng', spawnImplementation: implementation });

  assert.equal(await client.detectPageScript(page(1)), null);
});

test('detectPageScript declines a call it is not confident in', async () => {
  const { implementation } = fakeSpawn(osd('Latin', 0.4));
  const client = new TesseractClient({ container: 'tesseract-ocr', langs: 'heb+eng', spawnImplementation: implementation });

  assert.equal(await client.detectPageScript(page(1)), null);
});

test('AutoTesseractClient loads heb+eng for a page OSD calls Hebrew', async () => {
  const { implementation, calls } = fakeSpawnRuns([{ stdout: osd('Hebrew') }, { stdout: PAGE }]);
  const client = autoClient(implementation);

  const result = await client.recognizePage(page(1));

  assert.deepEqual(calls[0]?.args, OSD_ARGS);
  assert.deepEqual(calls[1]?.args, ['exec', '-i', 'tesseract-ocr', 'tesseract', 'stdin', 'stdout', '-l', 'heb+eng', 'tsv']);
  assert.equal(client.langs, 'heb+eng');
  assert.equal(result.text, 'שלום עולם\n~~ Ltd.\n\nTotal');
});

test('AutoTesseractClient drops heb for a page OSD calls Latin', async () => {
  const { implementation, calls } = fakeSpawnRuns([{ stdout: osd('Latin') }, { stdout: PAGE }]);
  const client = autoClient(implementation);

  await client.recognizePage(page(1));

  assert.deepEqual(calls[1]?.args, ['exec', '-i', 'tesseract-ocr', 'tesseract', 'stdin', 'stdout', '-l', 'eng', 'tsv']);
  assert.equal(client.langs, 'eng');
});

test('AutoTesseractClient falls back to heb+eng when OSD will not call the page', async () => {
  // heb+eng still reads a Latin page; eng on a Hebrew page returns nothing usable.
  const { implementation, calls } = fakeSpawnRuns([{ exitCode: 1, stderr: 'Too few characters. Skipping this page' }, { stdout: PAGE }]);
  const client = autoClient(implementation);

  await client.recognizePage(page(1));

  assert.equal(client.langs, 'heb+eng');
  assert.deepEqual(calls[1]?.args?.slice(-3), ['-l', 'heb+eng', 'tsv']);
});

test('AutoTesseractClient detects once per document, not once per page', async () => {
  const { implementation, calls } = fakeSpawnRuns([{ stdout: osd('Hebrew') }, { stdout: PAGE }]);
  const client = autoClient(implementation);

  await client.recognizePage(page(1));
  await client.recognizePage(page(2));
  await client.recognizePage(page(3));

  assert.equal(calls.filter((call) => call.args.includes('osd')).length, 1);
  assert.equal(calls.length, 4);
});

test('AutoTesseractClient re-detects on page 1, so a shared instance does not carry a language over', async () => {
  const { implementation, calls } = fakeSpawnRuns([
    { stdout: osd('Hebrew') },
    { stdout: PAGE },
    { stdout: osd('Latin') },
    { stdout: PAGE },
  ]);
  const client = autoClient(implementation);

  await client.recognizePage(page(1));
  assert.equal(client.langs, 'heb+eng');
  // The batch CLI reuses one instance across documents; page 1 is where the next begins.
  await client.recognizePage(page(1));
  assert.equal(client.langs, 'eng');
});
