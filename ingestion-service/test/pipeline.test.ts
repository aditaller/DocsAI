import assert from 'node:assert/strict';
import test from 'node:test';

import { Logger } from '../src/logger.js';
import { IngestionPipeline } from '../src/pipeline.js';
import { FakeArchiveReader, FakeOllama, FakePageRenderer, FakeRagStore } from './fakes.js';

test('pipeline records an atomic RAG document from a fake rendered page', async () => {
  const source = {
    archiveId: 42,
    sourceClaimId: 314,
    fileName: 'claim.png',
    mimeType: 'image/png',
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  const store = new FakeRagStore();
  const pipeline = new IngestionPipeline({
    archiveReader: new FakeArchiveReader(source),
    ragStore: store,
    renderer: new FakePageRenderer({
      sourceMimeType: 'image/png',
      pages: [{ pageIndex: 1, mimeType: 'image/png', bytes: source.bytes }],
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

  const result = await pipeline.ingest(source);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(store.completed, { jobId: 1, documentId: 99 });
  assert.equal(store.persisted?.chunks.length, 1);
  assert.deepEqual(store.persisted?.embeddings[0], [0.1, 0.2, 0.3]);
  assert.equal(store.chunking?.pageCount, 1);
  assert.equal(store.embedding?.chunkCount, 1);
});

test('pipeline writes a successful preflight record before ingestion', async () => {
  const source = {
    archiveId: 43,
    sourceClaimId: 315,
    fileName: 'claim.png',
    mimeType: 'image/png',
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  const store = new FakeRagStore();
  const pipeline = new IngestionPipeline({
    archiveReader: new FakeArchiveReader(source),
    ragStore: store,
    renderer: new FakePageRenderer({ sourceMimeType: 'image/png', pages: [] }),
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
  await pipeline.preflight();
  assert.deepEqual(store.preflights, [true]);
});
