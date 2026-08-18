import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArchivePreflight, ArchiveReader } from '../src/archive-reader.js';
import { ServiceError } from '../src/errors.js';
import { Logger } from '../src/logger.js';
import { averageConfidence, detectLanguage, meanTokenProbability, OllamaClient, toPercent } from '../src/ollama.js';
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

test('chat streams NDJSON tokens, forwards each one, and returns the joined answer', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  // Ollama frames arrive as newline-delimited JSON, and a network chunk can end
  // mid-line — the second chunk here splits "answer" across a boundary.
  const wire = [
    '{"message":{"content":"  the "}}\n{"message":{"con',
    'tent":"ans"}}\n',
    '{"message":{"content":"wer  "}}\n{"done":true,"done_reason":"stop"}\n',
  ];
  const client = new OllamaClient({
    baseUrl: new URL('http://127.0.0.1:11434'),
    ocrModel: 'vision',
    embeddingModel: 'embed',
    dimensions: 3,
    chatModel: 'chat-model',
    numContext: 16_384,
    keepAlive: '1h',
    fetchImplementation: (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const part of wire) controller.enqueue(encoder.encode(part));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      );
    }) as typeof fetch,
  });

  const tokens: string[] = [];
  assert.equal(await client.chat('system text', 'user text', (t) => tokens.push(t)), 'the answer');
  // The caller must see the fragments as they land, not one final blob.
  assert.deepEqual(tokens, ['  the ', 'ans', 'wer  ']);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(calls[0]?.body, {
    model: 'chat-model',
    stream: true,
    messages: [
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'user text' },
    ],
    options: { num_ctx: 16_384 },
    keep_alive: '1h',
  });
});

test('chat without a token callback still returns the whole answer', async () => {
  const client = new OllamaClient({
    baseUrl: new URL('http://127.0.0.1:11434'),
    ocrModel: 'vision',
    embeddingModel: 'embed',
    dimensions: 3,
    chatModel: 'chat-model',
    numContext: 16_384,
    fetchImplementation: (async () =>
      new Response('{"message":{"content":"one "}}\n{"message":{"content":"two"}}\n', { status: 200 })) as typeof fetch,
  });
  assert.equal(await client.chat('system', 'user'), 'one two');
});

test('chat reports an empty stream rather than returning a blank answer', async () => {
  const client = new OllamaClient({
    baseUrl: new URL('http://127.0.0.1:11434'),
    ocrModel: 'vision',
    embeddingModel: 'embed',
    dimensions: 3,
    chatModel: 'chat-model',
    numContext: 16_384,
    fetchImplementation: (async () => new Response('{"done":true,"done_reason":"length"}\n', { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => client.chat('system', 'user'), /done_reason=length/);
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

test('the OCR request leaves the model its whole budget for transcription', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = ocrClientReturning({ response: '{"text":"transcribed text"}', done_reason: 'stop' }, calls);

  assert.equal((await client.recognizePage(RENDERED_PAGE)).text, 'text: transcribed text');
  const sent = calls[0] ?? {};
  assert.deepEqual(Object.keys(sent).sort(), ['images', 'keep_alive', 'logprobs', 'model', 'options', 'prompt', 'stream', 'think']);
  assert.equal(sent['logprobs'], true);
  assert.match(String(sent['prompt']), /^Transcribe every piece of text.*Language:/s);
  assert.equal(sent['keep_alive'], '1h');
  assert.equal(sent['stream'], false);
  assert.equal(sent['think'], false);
  assert.deepEqual(sent['options'], { num_ctx: 16_384 });
  // The JSON grammar sends qwen3-vl's whole turn into `thinking` and leaves
  // `response` empty, so the OCR call must never ask for it.
  assert.ok(!('format' in sent), 'format must not be sent');
});

test('the page score is the geometric mean of the token probabilities', async () => {
  // ln(0.9) and ln(0.5): exp of their mean is sqrt(0.45) ≈ 0.6708.
  const client = ocrClientReturning({
    response: 'County Hospital',
    done_reason: 'stop',
    logprobs: [{ token: 'County', logprob: Math.log(0.9) }, { token: ' Hospital', logprob: Math.log(0.5) }],
  });
  const page = await client.recognizePage(RENDERED_PAGE);
  assert.ok(Math.abs((page.confidence ?? 0) - Math.sqrt(0.45)) < 1e-9);
  assert.equal(toPercent(page.confidence), 67.1);

  // An Ollama build that ignores the flag must report "no score", never 0%.
  assert.equal(meanTokenProbability(undefined), null);
  assert.equal(meanTokenProbability([]), null);
  assert.equal(meanTokenProbability([{ token: 'x' }]), null);
  assert.equal((await ocrClientReturning({ response: 'text', done_reason: 'stop' }).recognizePage(RENDERED_PAGE)).confidence, null);

  // Document score: pages without a score are left out, not counted as zero.
  assert.equal(averageConfidence([{ pageIndex: 1, text: 'a', confidence: 0.8 }, { pageIndex: 2, text: 'b' }]), 80);
  assert.equal(averageConfidence([{ pageIndex: 1, text: 'a' }]), null);
});

test('the language line the OCR prompt asks for is read back off the page', () => {
  assert.equal(detectLanguage('Language: Hebrew\nחשבונית מס'), 'Hebrew');
  assert.equal(detectLanguage('# Page 1\n\nlanguage:  English  \nCounty Hospital'), 'English');
  assert.equal(detectLanguage('County Hospital\n551 West'), null, 'a page without the line reports nothing');
  assert.equal(detectLanguage('Language:\nCounty Hospital'), null, 'an empty label is not a language');
});

test('every value in a JSON reply reaches the indexed text', async () => {
  const cases: Array<[string, string, string]> = [
    ['plain text, not JSON', 'County Hospital', 'County Hospital'],
    ['a bare JSON string', '"County Hospital"', 'County Hospital'],
    ['a flat object', '{"hospital":"County","total":"$500"}', 'hospital: County\ntotal: $500'],
    [
      'nested objects, as an invoice returns',
      '{"patient":{"name":"Apple Song","phone":"080 789 67 56"}}',
      'patient name: Apple Song\npatient phone: 080 789 67 56',
    ],
    [
      'arrays of line items',
      '{"items":[{"desc":"Full Check Up","price":"$700"},{"desc":"Vaccine","price":"$3 450"}]}',
      'items 1 desc: Full Check Up\nitems 1 price: $700\nitems 2 desc: Vaccine\nitems 2 price: $3 450',
    ],
    ['empty values are skipped', '{"a":"keep","b":"","c":null}', 'a: keep'],
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
