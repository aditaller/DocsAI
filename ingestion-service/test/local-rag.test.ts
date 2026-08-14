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

  assert.deepEqual(result, { archiveId: 7002, outcome: 'failed' });
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
  });
});

test('chat refuses to run when no chat model is configured', async () => {
  const client = new OllamaClient({
    baseUrl: new URL('http://127.0.0.1:11434'),
    ocrModel: 'vision',
    embeddingModel: 'embed',
    dimensions: 3,
  });
  await assert.rejects(() => client.chat('system', 'user'), /OLLAMA_CHAT_MODEL/);
});
