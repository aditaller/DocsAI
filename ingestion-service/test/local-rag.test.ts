import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArchivePreflight, ArchiveReader } from '../src/archive-reader.js';
import { ServiceError } from '../src/errors.js';
import { Logger } from '../src/logger.js';
import { OllamaClient } from '../src/ollama.js';
import { IngestionPipeline } from '../src/pipeline.js';
import { PostgresRagStore } from '../src/rag-store.js';
import type { ArchiveRecord, SourceFile } from '../src/types.js';
import { FakeOllama, FakePageRenderer, FakeRagStore } from './fakes.js';

/** Fails loudly if the interactive path ever falls back to SQL Server. */
class UnusableArchiveReader implements ArchiveReader {
  async preflight(): Promise<ArchivePreflight> {
    throw new Error('archive reader must not be used by the interactive path');
  }

  async listAfter(): Promise<ArchiveRecord[]> {
    throw new Error('archive reader must not be used by the interactive path');
  }

  async getById(): Promise<SourceFile> {
    throw new Error('archive reader must not be used by the interactive path');
  }

  async close(): Promise<void> {}
}

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function buildPipeline(store: FakeRagStore, pageCount = 2): IngestionPipeline {
  return new IngestionPipeline({
    archiveReader: new UnusableArchiveReader(),
    ragStore: store,
    renderer: new FakePageRenderer({
      sourceMimeType: 'image/png',
      pages: Array.from({ length: pageCount }, (_unused, index) => ({
        pageIndex: index + 1,
        mimeType: 'image/png' as const,
        bytes: PNG_HEADER,
      })),
    }),
    ollama: new FakeOllama(),
    mappingVersion: 'test-v1',
    embeddingDimensions: 3,
    chunkMaxCharacters: 200,
    chunkOverlapCharacters: 20,
    maxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 2,
    logger: new Logger('error'),
  });
}

test('ingestSource completes without reading SQL Server and returns per-page text', async () => {
  const store = new FakeRagStore();
  const result = await buildPipeline(store).ingestSource({
    archiveId: 7001,
    sourceClaimId: 314,
    fileName: 'upload.png',
    mimeType: 'image/png',
    bytes: PNG_HEADER,
  });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.archiveId, 7001);
  assert.deepEqual(
    result.pages,
    [
      { pageIndex: 1, text: 'text for page 1' },
      { pageIndex: 2, text: 'text for page 2' },
    ],
  );
  assert.equal(store.chunking?.pageCount, 2);
  assert.equal(store.completed?.documentId, 99);
});

test('an interactive re-submit may reclaim a terminally failed run; the batch path may not', async () => {
  const interactive = new FakeRagStore();
  await buildPipeline(interactive).ingestSource(
    { archiveId: 15095, sourceClaimId: 2, fileName: 'medicalfile4.jpg', mimeType: 'image/jpeg', bytes: PNG_HEADER },
    { retryTerminal: true },
  );
  assert.equal(interactive.claimedWithFailed, true);

  // Without the option the run row would stay FAILED forever and the document
  // could never be retried through the UI.
  const batch = new FakeRagStore();
  await buildPipeline(batch).ingestSource(
    { archiveId: 15095, sourceClaimId: 2, fileName: 'medicalfile4.jpg', mimeType: 'image/jpeg', bytes: PNG_HEADER },
  );
  assert.equal(batch.claimedWithFailed, false);
});

test('a failed run carries the real reason, not a generic message', async () => {
  const store = new FakeRagStore();
  store.createJob = async () => {
    // What a missing rag.claim row actually raises inside createJob.
    throw new ServiceError('Source claim 20 does not exist in rag.claim', 'source_not_found', false);
  };

  const result = await buildPipeline(store).ingestSource({
    archiveId: 15095,
    sourceClaimId: 20,
    fileName: 'medicalfile4.jpg',
    mimeType: 'image/jpeg',
    bytes: PNG_HEADER,
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'source_not_found');
  assert.match(result.error?.message ?? '', /does not exist in rag\.claim/);
  assert.equal(result.error?.retryable, false);
});

test('ingestSource reports the archive id when the run fails before a job exists', async () => {
  const store = new FakeRagStore();
  store.createJob = async () => {
    throw new ServiceError('postgres is down', 'database', true);
  };

  const result = await buildPipeline(store).ingestSource({
    archiveId: 7002,
    sourceClaimId: 314,
    fileName: 'upload.png',
    mimeType: 'image/png',
    bytes: PNG_HEADER,
  });

  assert.equal(result.archiveId, 7002);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'database');
});

test('the run is scoped by the resolved surrogate id, never the raw entity id', async () => {
  const store = new FakeRagStore();
  store.scopeId = 4242;
  const scopeId = await store.resolveScope('bp.customer', 5000, 'Acme Ltd');

  await buildPipeline(store).ingestSource({
    archiveId: 15095,
    sourceClaimId: scopeId,
    fileName: 'medicalfile4.jpg',
    mimeType: 'image/jpeg',
    bytes: PNG_HEADER,
  });

  // Customer 5000 and claim 5000 must not land on the same rag.claim row, so the
  // entity id must never reach createJob.
  assert.deepEqual(store.createdWith, { archiveId: 15095, claimId: 4242 });
  assert.deepEqual(store.scopeCalls, [{ objectType: 'bp.customer', objectId: 5000, label: 'Acme Ltd' }]);
});

test('searchChunks rejects a query vector of the wrong dimension before querying', async () => {
  const store = new PostgresRagStore('postgres://unused/unused', {
    writeUserId: 1,
    embeddingModel: 'test-embed',
    embeddingDimensions: 3,
  });
  await assert.rejects(() => store.searchChunks([0.1, 0.2], [1], 8), /dimensions/);
  await store.close();
});

test('searchChunks returns nothing when no valid document id is supplied', async () => {
  const store = new PostgresRagStore('postgres://unused/unused', {
    writeUserId: 1,
    embeddingModel: 'test-embed',
    embeddingDimensions: 3,
  });
  assert.deepEqual(await store.searchChunks([0.1, 0.2, 0.3], [0, -4, Number.NaN], 8), []);
  await store.close();
});

test('chat posts to /api/chat and returns the message content', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new OllamaClient({
    baseUrl: new URL('http://127.0.0.1:11434'),
    ocrModel: 'vision',
    embeddingModel: 'embed',
    dimensions: 3,
    chatModel: 'chat-model',
    numContext: 16_384,
    fetchImplementation: (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ message: { content: '  the answer  ' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });

  assert.equal(await client.chat('system text', 'user text'), 'the answer');
  assert.equal(calls[0]?.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(calls[0]?.body, {
    model: 'chat-model',
    stream: false,
    messages: [
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'user text' },
    ],
    options: { num_ctx: 16_384 },
  });
});

test('chat refuses to run when no chat model is configured', async () => {
  const client = new OllamaClient({
    baseUrl: new URL('http://127.0.0.1:11434'),
    ocrModel: 'vision',
    embeddingModel: 'embed',
    dimensions: 3,
    numContext: 16_384,
  });
  await assert.rejects(() => client.chat('system', 'user'), /OLLAMA_CHAT_MODEL/);
});

/** Builds a client whose fetch returns one canned /api/generate body. */
function ocrClientReturning(body: unknown, capture?: Array<Record<string, unknown>>): OllamaClient {
  return new OllamaClient({
    baseUrl: new URL('http://127.0.0.1:11434'),
    ocrModel: 'vision',
    embeddingModel: 'embed',
    dimensions: 3,
    numContext: 16_384,
    fetchImplementation: (async (_input: URL | RequestInfo, init?: RequestInit) => {
      capture?.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
}

const RENDERED_PAGE = { pageIndex: 1, mimeType: 'image/png' as const, bytes: Buffer.from([137, 80, 78, 71]) };

test('OCR disables thinking, requests JSON, and sets the context', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = ocrClientReturning({ response: '{"text":"transcribed text"}', done_reason: 'stop' }, calls);

  assert.equal((await client.recognizePage(RENDERED_PAGE)).text, 'transcribed text');
  // qwen3.6 spends its whole budget in the thinking channel otherwise, returning
  // an empty response with done_reason "length".
  assert.equal(calls[0]?.['think'], false);
  assert.equal(calls[0]?.['format'], 'json');
  assert.deepEqual(calls[0]?.['options'], { num_ctx: 16_384 });
});

test('a JSON reply that breaks the contract still yields its text rather than nothing', async () => {
  const cases: Array<[string, string, string]> = [
    ['plain string, not JSON at all', 'County Hospital', 'County Hospital'],
    ['the agreed shape', '{"text":"County Hospital"}', 'County Hospital'],
    ['a different key', '{"transcription":"County Hospital"}', 'County Hospital'],
    ['lines under the key', '{"text":["County Hospital","551 West Street"]}', 'County Hospital\n551 West Street'],
    ['an unexpected key', '{"page":"County Hospital"}', 'County Hospital'],
    ['a bare JSON string', '"County Hospital"', 'County Hospital'],
  ];
  for (const [label, response, expected] of cases) {
    const client = ocrClientReturning({ response, done_reason: 'stop' });
    assert.equal((await client.recognizePage(RENDERED_PAGE)).text, expected, label);
  }

  // Truncated mid-escape: keep the raw text, because a page indexed with stray
  // JSON punctuation is recoverable and a dropped page is not.
  const truncated = ocrClientReturning({ response: '{"text":"County Hospital\\n551 West', done_reason: 'length' });
  assert.match((await truncated.recognizePage(RENDERED_PAGE)).text, /County Hospital/);
});

test('an empty OCR response is reported as a budget problem, not as a blank page', async () => {
  const client = ocrClientReturning({ response: '', done_reason: 'length', eval_count: 3337 });
  await assert.rejects(
    () => client.recognizePage(RENDERED_PAGE),
    (error: Error) => /done_reason=length/.test(error.message) && /OLLAMA_NUM_CTX/.test(error.message),
  );
});

test('a truncated page is surfaced to the caller but still returned', async () => {
  const truncated: number[] = [];
  const client = new OllamaClient({
    baseUrl: new URL('http://127.0.0.1:11434'),
    ocrModel: 'vision',
    embeddingModel: 'embed',
    dimensions: 3,
    numContext: 16_384,
    onTruncated: (pageIndex) => truncated.push(pageIndex),
    fetchImplementation: (async () =>
      new Response(JSON.stringify({ response: 'half a page', done_reason: 'length' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });

  assert.equal((await client.recognizePage(RENDERED_PAGE)).text, 'half a page');
  assert.deepEqual(truncated, [1]);
});
