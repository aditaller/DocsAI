import type { ArchivePreflight, ArchiveReader } from '../src/archive-reader.js';
import type { ChatModel, OcrEmbedder } from '../src/ollama.js';
import type { ChunkHit, JobRecord, PersistedDocument, RagStore } from '../src/rag-store.js';
import type { PageRenderer } from '../src/renderer.js';
import type { ArchiveRecord, RenderedDocument, SourceFile, TextChunk, TextPage } from '../src/types.js';

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
  lastSearch?: { embedding: number[]; documentIds: number[]; topK: number };
  completed?: { jobId: number; documentId: number };
  failure?: { jobId: number; state: 'RETRY_WAIT' | 'FAILED' };
  persisted?: { chunks: TextChunk[]; embeddings: number[][] };
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

  async createJob(sourceArchiveId: number, sourceClaimId: number, _mappingVersion: string, _sourceFingerprint: string, _sourceHash: string): Promise<JobRecord> {
    this.createdWith = { archiveId: sourceArchiveId, claimId: sourceClaimId };
    return { id: 1, ragClaimId: 5, state: 'PENDING', attempts: 0, claimed: false };
  }

  async claimJob(_jobId: number): Promise<JobRecord> {
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
    this.persisted = { chunks: input.chunks, embeddings: input.embeddings };
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

  async resolveScope(objectType: string, objectId: number, label: string): Promise<number> {
    this.scopeCalls.push({ objectType, objectId, label });
    return this.scopeId;
  }

  async close(): Promise<void> {}
}
