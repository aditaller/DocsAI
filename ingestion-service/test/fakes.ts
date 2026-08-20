import type { ArchivePreflight, ArchiveReader } from '../src/archive-reader.js';
import type { ChatModel, OcrEmbedder } from '../src/ollama.js';
import type { ChunkHit, JobRecord, PersistedDocument, RagStore } from '../src/rag-store.js';
import type { PageRenderer } from '../src/renderer.js';
import type { AnalyzedDocument, ArchiveRecord, DocumentAnalyzer, FormAnswer, PageRecognizer, RenderedDocument, RenderedPage, SourceFile, TextChunk, TextPage } from '../src/types.js';

/**
 * Stands in for the Azure Layout container: a whole-document engine that reports
 * answers, which no PageRecognizer can. Records the bytes it was handed so a
 * test can prove the pipeline sent the original PDF rather than a page render.
 */
export class FakeDocumentAnalyzer implements DocumentAnalyzer {
  receivedBytes?: Buffer;
  receivedMimeType?: string;

  constructor(private readonly result: AnalyzedDocument) {}

  async analyzeDocument(bytes: Buffer, mimeType: string): Promise<AnalyzedDocument> {
    this.receivedBytes = bytes;
    this.receivedMimeType = mimeType;
    return this.result;
  }
}

export class FakePageRenderer implements PageRenderer {
  calls = 0;

  constructor(private readonly result: RenderedDocument) {}

  async render(_source: SourceFile): Promise<RenderedDocument> {
    this.calls += 1;
    return this.result;
  }
}

export class FakeArchiveReader implements ArchiveReader {
  constructor(private readonly source: SourceFile) {}

  async preflight(): Promise<ArchivePreflight> {
    return { relation: 'gnr.v_archive', configuredColumns: ['archiveid', 'claimid'], availableColumns: ['archiveid', 'claimid'], missingColumns: [] };
  }

  async listAfter(_afterId: number, _limit: number): Promise<ArchiveRecord[]> {
    return [this.source];
  }

  async getById(_archiveId: number): Promise<SourceFile> {
    return this.source;
  }

  async close(): Promise<void> {}
}

export class FakeOllama implements OcrEmbedder {
  async recognizePage(page: { pageIndex: number }): Promise<{ pageIndex: number; text: string }> {
    return { pageIndex: page.pageIndex, text: `text for page ${page.pageIndex}` };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}

/** A second OCR engine, so a test can tell which one the pipeline actually used. */
export class FakeRecognizer implements PageRecognizer {
  seen: number[] = [];

  constructor(private readonly label = 'other engine') {}

  async recognizePage(page: RenderedPage): Promise<TextPage> {
    this.seen.push(page.pageIndex);
    return { pageIndex: page.pageIndex, text: `${this.label} page ${page.pageIndex}`, confidence: 0.5 };
  }
}

export class FakeChatModel implements ChatModel {
  lastCall?: { systemMessage: string; userMessage: string };

  constructor(private readonly reply = 'fake reply') {}

  async chat(systemMessage: string, userMessage: string): Promise<string> {
    this.lastCall = { systemMessage, userMessage };
    return this.reply;
  }
}

export class FakeRagStore implements RagStore {
  hits: ChunkHit[] = [];
  storedPages: TextPage[] = [];
  /** Deliberately unequal to any entity id a test passes, so a mix-up shows up. */
  scopeId = 4242;
  scopeCalls: Array<{ objectType: string; objectId: number; label: string }> = [];
  createdWith?: { archiveId: number; claimId: number };
  lastFingerprint?: string;
  lastSearch?: { embedding: number[]; documentIds: number[]; topK: number };
  completed?: { jobId: number; documentId: number };
  failure?: { jobId: number; state: 'RETRY_WAIT' | 'FAILED' };
  persisted?: { chunks: TextChunk[]; embeddings: number[][]; pages: TextPage[]; answers: FormAnswer[] };
  chunking?: { jobId: number; pageCount: number; markdownFullText: string; parseDurationMs: number };
  embedding?: { jobId: number; chunkCount: number };
  preflights: boolean[] = [];

  async recordPreflight(_mappingVersion: string, succeeded: boolean, _detail: unknown): Promise<void> {
    this.preflights.push(succeeded);
  }

  async preflight(): Promise<void> {}

  async listDueRetryArchiveIds(_limit: number): Promise<number[]> {
    return [];
  }

  async createJob(sourceArchiveId: number, sourceClaimId: number, _mappingVersion: string, sourceFingerprint: string, _sourceHash: string): Promise<JobRecord> {
    this.createdWith = { archiveId: sourceArchiveId, claimId: sourceClaimId };
    this.lastFingerprint = sourceFingerprint;
    return { id: 1, ragClaimId: 5, state: 'PENDING', attempts: 0, claimed: false };
  }

  claimedWithFailed?: boolean;

  async claimJob(_jobId: number, includeFailed = false): Promise<JobRecord> {
    this.claimedWithFailed = includeFailed;
    return { id: 1, ragClaimId: 5, state: 'PARSING', attempts: 1, claimed: true };
  }

  async markChunking(jobId: number, pageCount: number, markdownFullText: string, parseDurationMs: number): Promise<void> {
    this.chunking = { jobId, pageCount, markdownFullText, parseDurationMs };
  }

  async markEmbedding(jobId: number, chunkCount: number): Promise<void> {
    this.embedding = { jobId, chunkCount };
  }

  async failJob(jobId: number, state: 'RETRY_WAIT' | 'FAILED', _error: { code: string; message: string }, _nextAttemptAt?: Date): Promise<void> {
    this.failure = { jobId, state };
  }

  async persistDocument(input: Parameters<RagStore['persistDocument']>[0]): Promise<PersistedDocument> {
    this.persisted = { chunks: input.chunks, embeddings: input.embeddings, pages: input.pages, answers: input.answers ?? [] };
    this.completed = { jobId: input.jobId, documentId: 99 };
    return { id: 99, ragDocumentId: 7, alreadyExisted: false };
  }

  async searchChunks(embedding: number[], documentIds: number[], topK: number): Promise<ChunkHit[]> {
    this.lastSearch = { embedding, documentIds, topK };
    return this.hits;
  }

  async getDocumentPages(_documentId: number): Promise<TextPage[]> {
    return this.storedPages;
  }

  storedDurationMs: number | null = null;

  async getDocumentDurationMs(_documentId: number): Promise<number | null> {
    return this.storedDurationMs;
  }

  async resolveScope(objectType: string, objectId: number, label: string): Promise<number> {
    this.scopeCalls.push({ objectType, objectId, label });
    return this.scopeId;
  }

  async close(): Promise<void> {}
}
