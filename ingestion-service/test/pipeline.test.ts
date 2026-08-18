import assert from 'node:assert/strict';
import test from 'node:test';

import { Logger } from '../src/logger.js';
import { IngestionPipeline } from '../src/pipeline.js';
import { FakeArchiveReader, FakeOllama, FakePageRenderer, FakeRagStore, FakeRecognizer } from './fakes.js';

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

test('a per-request engine reads the pages and marks the run as its own', async () => {
  const source = {
    archiveId: 44,
    sourceClaimId: 316,
    fileName: 'claim.png',
    mimeType: 'image/png',
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  const store = new FakeRagStore();
  const ollama = new FakeOllama();
  const tesseract = new FakeRecognizer('tesseract');
  const pipeline = new IngestionPipeline({
    ragStore: store,
    renderer: new FakePageRenderer({
      sourceMimeType: 'image/png',
      pages: [{ pageIndex: 1, mimeType: 'image/png', bytes: source.bytes }],
    }),
    ollama,
    mappingVersion: 'test-v1',
    embeddingDimensions: 3,
    chunkMaxCharacters: 200,
    chunkOverlapCharacters: 20,
    maxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 2,
    logger: new Logger('error'),
  });

  const result = await pipeline.ingestSource(source, { ocr: { id: 'tesseract-heb', recognizer: tesseract } });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(tesseract.seen, [1]);
  assert.equal(result.pages?.[0]?.text, 'tesseract page 1');
  // The board's "Total time" column reads this, and rag.ingestionrun stores it.
  assert.ok(typeof result.totalDurationMs === 'number' && result.totalDurationMs >= 0);
  // The engine is part of the run's identity, so re-reading the same bytes with
  // the other engine is a new run rather than a skipped duplicate.
  assert.match(store.lastFingerprint ?? '', /@tesseract-heb$/);

  // The two tesseract language sets are separate engines for the same reason:
  // switching HEB to ENG must re-read the page, not return the Hebrew run's text.
  const hebrewFingerprint = store.lastFingerprint;
  await pipeline.ingestSource(source, { ocr: { id: 'tesseract-eng', recognizer: new FakeRecognizer('eng') } });
  assert.match(store.lastFingerprint ?? '', /@tesseract-eng$/);
  assert.notEqual(store.lastFingerprint, hebrewFingerprint);
});

test('a digital PDF skips the OCR engine and stores its own text', async () => {
  const source = {
    archiveId: 46,
    sourceClaimId: 318,
    fileName: 'typed.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.from('%PDF-1.7 typed'),
  };
  const store = new FakeRagStore();
  const tesseract = new FakeRecognizer('tesseract');
  const pipeline = new IngestionPipeline({
    ragStore: store,
    // What PopplerPdfRenderer returns for a PDF that carries a text layer:
    // no rasterised pages at all, just the text.
    renderer: new FakePageRenderer({
      sourceMimeType: 'application/pdf',
      pages: [],
      textPages: [
        { pageIndex: 1, text: 'first page text', confidence: 1 },
        { pageIndex: 2, text: 'second page text', confidence: 1 },
      ],
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

  const result = await pipeline.ingestSource(source, { ocr: { id: 'tesseract-heb', recognizer: tesseract } });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(tesseract.seen, [], 'OCR must not run over text the document already carries');
  // Page count comes from the text pages, not from an empty render list — the
  // store, the board's page column and every citation depend on it.
  assert.equal(store.chunking?.pageCount, 2);
  assert.equal(store.persisted?.pages.length, 2);
  assert.equal(store.persisted?.pages[1]?.text, 'second page text');
  assert.equal(result.pages?.[0]?.text, 'first page text');
});

test('the default engine keeps the original fingerprint, so indexed documents are not re-read', async () => {
  const source = {
    archiveId: 45,
    sourceClaimId: 317,
    fileName: 'claim.png',
    mimeType: 'image/png',
    bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  const store = new FakeRagStore();
  const pipeline = new IngestionPipeline({
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

  await pipeline.ingestSource(source, { ocr: { id: 'ollama', recognizer: new FakeOllama() } });
  assert.match(store.lastFingerprint ?? '', /^content:[0-9a-f]+$/);
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
