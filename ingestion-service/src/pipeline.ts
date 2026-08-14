import { contentHash, chunkPages } from './chunker.js';
import { ServiceError, sanitizeError } from './errors.js';
import { Logger } from './logger.js';
import type { OcrEmbedder } from './ollama.js';
import type { RagStore } from './rag-store.js';
import { retryDelayMs } from './retry.js';
import type { ArchiveReader } from './archive-reader.js';
import type { PageRenderer } from './renderer.js';
import type { ArchiveRecord, SourceFile, TextPage } from './types.js';

export interface IngestionResult {
  archiveId: number;
  outcome: 'completed' | 'skipped' | 'retry_wait' | 'failed';
  documentId?: number;
  ragDocumentId?: number;
  /** Present only on a fresh `completed` run; a skip reuses what is already stored. */
  pages?: TextPage[];
}

export class IngestionPipeline {
  constructor(
    private readonly dependencies: {
      // Absent on the interactive path, which is handed its bytes and so never
      // reaches SQL Server. Every route that does need it goes through the getter.
      archiveReader?: ArchiveReader;
      ragStore: RagStore;
      renderer: PageRenderer;
      ollama: OcrEmbedder;
      mappingVersion: string;
      embeddingDimensions: number;
      chunkMaxCharacters: number;
      chunkOverlapCharacters: number;
      maxAttempts: number;
      retryBaseMs: number;
      retryMaxMs: number;
      logger: Logger;
    },
  ) {}

  private get archiveReader(): ArchiveReader {
    const reader = this.dependencies.archiveReader;
    if (!reader) throw new ServiceError('This operation needs the SQL Server archive reader, which is not configured', 'configuration', false);
    return reader;
  }

  async preflight(): Promise<void> {
    try {
      const source = await this.archiveReader.preflight();
      if (source.missingColumns.length > 0) {
        throw new ServiceError(`Archive mapping columns are missing: ${source.missingColumns.join(', ')}`, 'preflight', false);
      }
      await this.dependencies.ragStore.preflight();
      await this.dependencies.ragStore.recordPreflight(this.dependencies.mappingVersion, true, source);
      this.dependencies.logger.info('preflight_succeeded', {
        mappingVersion: this.dependencies.mappingVersion,
        relation: source.relation,
        columnCount: source.availableColumns.length,
      });
    } catch (error) {
      const safe = sanitizeError(error);
      await this.dependencies.ragStore
        .recordPreflight(this.dependencies.mappingVersion, false, { error: safe })
        .catch((recordError: unknown) => {
          const recordSafe = sanitizeError(recordError);
          this.dependencies.logger.error('preflight_failure_recording_failed', recordSafe);
        });
      this.dependencies.logger.error('preflight_failed', { mappingVersion: this.dependencies.mappingVersion, ...safe });
      throw error;
    }
  }

  async preview(afterId: number, limit: number): Promise<ArchiveRecord[]> {
    return this.archiveReader.listAfter(afterId, limit);
  }

  /** Batch path: the archive owns the bytes, so they are fetched from SQL Server first. */
  async ingest(record: ArchiveRecord): Promise<IngestionResult> {
    return this.run(record.archiveId, () => this.archiveReader.getById(record.archiveId));
  }

  /**
   * Interactive path: the caller already holds the bytes (the UI streamed them
   * from the archive route), so SQL Server is never touched. Everything after
   * the load — idempotence, run states, retry classification — is shared.
   */
  async ingestSource(source: SourceFile): Promise<IngestionResult> {
    return this.run(source.archiveId, async () => source);
  }

  private async run(archiveId: number, load: () => Promise<SourceFile>): Promise<IngestionResult> {
    let jobId: number | undefined;
    let attempts = 0;
    try {
      const totalStartedAt = Date.now();
      const source = await load();
      const sourceHash = contentHash(source.bytes);
      const sourceFingerprint = source.sourceRevision ? `source:${source.sourceRevision}` : `content:${sourceHash}`;
      const job = await this.dependencies.ragStore.createJob(source.archiveId, source.sourceClaimId, this.dependencies.mappingVersion, sourceFingerprint, sourceHash);
      jobId = job.id;
      const claimed = await this.dependencies.ragStore.claimJob(job.id);
      attempts = claimed.attempts;
      if (!claimed.claimed) {
        this.dependencies.logger.info('ingestion_skipped', {
          archiveId: source.archiveId,
          jobId: job.id,
          state: claimed.state,
          documentId: claimed.documentId,
        });
        return { archiveId: source.archiveId, outcome: 'skipped', ...(claimed.documentId ? { documentId: claimed.documentId, ragDocumentId: claimed.documentId } : {}) };
      }

      const parseStartedAt = Date.now();
      const rendered = await this.dependencies.renderer.render(source);
      const pages = [];
      for (const page of rendered.pages) pages.push(await this.dependencies.ollama.recognizePage(page));
      const parseDurationMs = Date.now() - parseStartedAt;
      const markdownFullText = pages.map((page) => `# Page ${page.pageIndex}\n\n${page.text}`).join('\n\n');
      await this.dependencies.ragStore.markChunking(job.id, rendered.pages.length, markdownFullText, parseDurationMs);

      const chunks = chunkPages(pages, this.dependencies.chunkMaxCharacters, this.dependencies.chunkOverlapCharacters);
      if (chunks.length === 0) throw new ServiceError('OCR produced no indexable text', 'ollama', false);
      await this.dependencies.ragStore.markEmbedding(job.id, chunks.length);

      const embeddingStartedAt = Date.now();
      const embeddings = await this.dependencies.ollama.embed(chunks.map((chunk) => chunk.content));
      const embedDurationMs = Date.now() - embeddingStartedAt;
      const persisted = await this.dependencies.ragStore.persistDocument({
        jobId: job.id,
        ragClaimId: claimed.ragClaimId,
        sourceArchiveId: source.archiveId,
        mappingVersion: this.dependencies.mappingVersion,
        sourceFingerprint,
        contentHash: sourceHash,
        sourceName: source.fileName,
        sourceMimeType: rendered.sourceMimeType,
        sourceStoragePath: source.fullPath ?? `archive://${this.dependencies.mappingVersion}/${source.sourceClaimId}/${source.archiveId}`,
        sourceSizeBytes: source.bytes.length,
        pages,
        chunks,
        embeddings,
        embeddingDimensions: this.dependencies.embeddingDimensions,
        completion: {
          pageCount: rendered.pages.length,
          chunkCount: chunks.length,
          parseDurationMs,
          embedDurationMs,
          totalDurationMs: Date.now() - totalStartedAt,
        },
      });
      this.dependencies.logger.info('ingestion_completed', {
        archiveId: source.archiveId,
        jobId: job.id,
        documentId: persisted.id,
        ragDocumentId: persisted.ragDocumentId,
        chunkCount: chunks.length,
        pageCount: rendered.pages.length,
        reused: persisted.alreadyExisted,
      });
      return {
        archiveId: source.archiveId,
        outcome: 'completed',
        documentId: persisted.id,
        ragDocumentId: persisted.ragDocumentId,
        pages,
      };
    } catch (error) {
      const safe = sanitizeError(error);
      if (!jobId) {
        this.dependencies.logger.error('ingestion_failed_before_job', { archiveId, ...safe });
        return { archiveId, outcome: 'failed' };
      }
      const retryable = safe.retryable && attempts < this.dependencies.maxAttempts;
      const nextAttemptAt = retryable
        ? new Date(Date.now() + retryDelayMs(attempts, this.dependencies.retryBaseMs, this.dependencies.retryMaxMs))
        : undefined;
      try {
        await this.dependencies.ragStore.failJob(jobId, retryable ? 'RETRY_WAIT' : 'FAILED', safe, nextAttemptAt);
      } catch (jobError) {
        const jobSafe = sanitizeError(jobError);
        this.dependencies.logger.error('ingestion_failure_recording_failed', { archiveId, jobId, ...jobSafe });
      }
      this.dependencies.logger[retryable ? 'warn' : 'error']('ingestion_failed', {
        archiveId,
        jobId,
        attempts,
        retryable,
        code: safe.code,
        message: safe.message,
      });
      return { archiveId, outcome: retryable ? 'retry_wait' : 'failed' };
    }
  }

  async ingestBatch(afterId: number, limit: number): Promise<IngestionResult[]> {
    const retryArchiveIds = await this.dependencies.ragStore.listDueRetryArchiveIds(limit);
    const records: ArchiveRecord[] = retryArchiveIds.map((archiveId) => ({ archiveId, sourceClaimId: 0, fileName: `archive-${archiveId}` }));
    const seen = new Set(records.map((record) => record.archiveId));
    const remaining = Math.max(0, limit - records.length);
    if (remaining > 0) {
      for (const record of await this.archiveReader.listAfter(afterId, remaining)) {
        if (seen.has(record.archiveId)) continue;
        records.push(record);
        seen.add(record.archiveId);
        if (records.length >= limit) break;
      }
    }
    const results: IngestionResult[] = [];
    // Intentionally serial: keeps local OCR/RAM pressure bounded. Run separate
    // workers only after validating database capacity and source mappings.
    for (const record of records) results.push(await this.ingest(record));
    return results;
  }
}
