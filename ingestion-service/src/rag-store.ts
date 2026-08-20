import { Pool, type PoolClient } from 'pg';

import { contentHash } from './chunker.js';
import { quotePostgresRelation } from './config.js';
import { ServiceError } from './errors.js';
import type { FormAnswer, IngestionJobState, TextChunk, TextPage } from './types.js';

const SOURCE_LOCK = 271828182;
const SCOPE_LOCK = 141421356;
/**
 * Marks a row as belonging to this local pipeline, not to a particular OCR
 * engine — tesseract-read chunks carry it too. The value is a search filter in
 * searchChunks, so changing it would orphan every chunk already embedded.
 */
const LOCAL_PARSER_CODE = 'OLLAMA_QWEN3_6_LOCAL';
const RAG_SCHEMA = 'rag';

/**
 * These names were verified against the local ragdb base relations. Keep them
 * explicit: preflight refuses to write if an installation has a different
 * schema, rather than treating similarly named "generic" audit columns as a
 * contract.
 */
const BASE_COLUMNS = {
  document: ['id', 'createuserid', 'claimid', 'filename', 'originalfilename', 'mimetype', 'sizebytes', 'sha256', 'storagepath'],
  documentchunk: ['id', 'createuserid', 'ingestionrunid', 'documentid', 'claimid', 'parsercode', 'chunkindex', 'tokencount', 'charcount', 'contenttext', 'contentembedding'],
  ingestionrun: ['id', 'createuserid', 'documentid', 'claimid', 'parsercode', 'embeddingmodel', 'embeddingdims', 'statuscode'],
} as const;

const RUN_COLUMNS = [
  'archiveid',
  'mappingversion',
  'sourcefingerprint',
  'sourcehash',
  'attempts',
  'nextattemptat',
  'processingstartedat',
  'processingcompletedat',
  'pagecount',
  'chunkcount',
  'markdownfulltext',
  'parsedurationms',
  'embeddingdurationms',
  'totaldurationms',
  'errormessage',
] as const;

export interface JobRecord {
  id: number;
  ragClaimId: number;
  state: IngestionJobState;
  attempts: number;
  claimed: boolean;
  documentId?: number;
  nextAttemptAt?: Date;
}

export interface PersistedDocument {
  id: number;
  ragDocumentId: number;
  alreadyExisted: boolean;
}

export interface ChunkHit {
  documentId: number;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  content: string;
  distance: number;
}

export interface RagStore {
  recordPreflight(mappingVersion: string, succeeded: boolean, detail: unknown): Promise<void>;
  preflight(): Promise<void>;
  listDueRetryArchiveIds(limit: number): Promise<number[]>;
  createJob(sourceArchiveId: number, sourceClaimId: number, mappingVersion: string, sourceFingerprint: string, sourceHash: string): Promise<JobRecord>;
  claimJob(jobId: number, includeFailed?: boolean): Promise<JobRecord>;
  markChunking(jobId: number, pageCount: number, markdownFullText: string, parseDurationMs: number): Promise<void>;
  markEmbedding(jobId: number, chunkCount: number): Promise<void>;
  persistDocument(input: {
    jobId: number;
    ragClaimId: number;
    sourceArchiveId: number;
    mappingVersion: string;
    sourceFingerprint: string;
    contentHash: string;
    sourceName: string;
    sourceMimeType: string;
    sourceStoragePath: string;
    sourceSizeBytes: number;
    pages: TextPage[];
    /** Structured answers, when the engine reads any. Only azure-layout does. */
    answers?: FormAnswer[];
    chunks: TextChunk[];
    embeddings: number[][];
    embeddingDimensions: number;
    completion: {
    pageCount: number;
    chunkCount: number;
    parseDurationMs: number;
    embedDurationMs: number;
    totalDurationMs: number;
    };
  }): Promise<PersistedDocument>;
  failJob(jobId: number, state: 'RETRY_WAIT' | 'FAILED', error: { code: string; message: string }, nextAttemptAt?: Date): Promise<void>;
  searchChunks(embedding: number[], documentIds: number[], topK: number): Promise<ChunkHit[]>;
  getDocumentPages(documentId: number): Promise<TextPage[]>;
  getDocumentDurationMs(documentId: number): Promise<number | null>;
  resolveScope(objectType: string, objectId: number, label: string): Promise<number>;
  close(): Promise<void>;
}

export class PostgresRagStore implements RagStore {
  private readonly pool: Pool;

  constructor(
    connectionString: string,
    private readonly options: {
      writeUserId: number;
      embeddingModel: string;
      embeddingDimensions: number;
    },
  ) {
    this.pool = new Pool({ connectionString, max: 4, application_name: 'document-intelligence-rag-ingestion' });
  }

  async preflight(): Promise<void> {
    await Promise.all([
      this.assertColumns('claim', ['id']),
      this.assertColumns('document', BASE_COLUMNS.document),
      this.assertColumns('documentchunk', BASE_COLUMNS.documentchunk),
      this.assertColumns('ingestionrun', [...BASE_COLUMNS.ingestionrun, ...RUN_COLUMNS]),
      this.assertColumns('documentpage', ['id', 'documentid', 'pagenumber', 'ocrtext', 'contenthash']),
      this.assertColumns('documentchunkpage', ['documentchunkid', 'documentpageid']),
      this.assertColumns('documentfield', ['id', 'documentid', 'pagenumber', 'label', 'questiontext', 'kind', 'value', 'confidence']),
      this.assertColumns('ingestion_preflight_run', ['id', 'mappingversion', 'succeeded', 'detail']),
    ]);

    const nullability = await this.pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'ingestionrun' AND column_name = 'documentid'`,
      [RAG_SCHEMA],
    );
    if (nullability.rows[0]?.is_nullable !== 'YES') {
      throw new ServiceError('RAG preflight: rag.ingestionrun.documentid must be nullable before ingestion begins', 'preflight', false);
    }
  }

  async recordPreflight(mappingVersion: string, succeeded: boolean, detail: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.table('ingestion_preflight_run')} (mappingversion, succeeded, detail)
       VALUES ($1, $2, $3::jsonb)`,
      [mappingVersion, succeeded, JSON.stringify(detail)],
    );
  }

  async listDueRetryArchiveIds(limit: number): Promise<number[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const result = await this.pool.query<{ archiveid: number | string }>(
      `WITH due AS (
         SELECT DISTINCT ON (archiveid) archiveid, nextattemptat, id AS runid
         FROM ${this.table('ingestionrun')}
         WHERE statuscode = 'RETRY_WAIT' AND nextattemptat IS NOT NULL AND nextattemptat <= now()
         ORDER BY archiveid, nextattemptat, id
       )
       SELECT archiveid FROM due ORDER BY nextattemptat, runid LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => Number(row.archiveid)).filter((value) => Number.isSafeInteger(value) && value > 0);
  }

  async createJob(sourceArchiveId: number, sourceClaimId: number, mappingVersion: string, sourceFingerprint: string, sourceHash: string): Promise<JobRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertClaimExists(sourceClaimId, client);
      const result = await client.query<JobRow>(
        `INSERT INTO ${this.table('ingestionrun')} (
           createuserid, documentid, claimid, parsercode, embeddingmodel, embeddingdims, statuscode,
           archiveid, mappingversion, sourcefingerprint, sourcehash, attempts
         )
         VALUES ($1, NULL, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, 0)
         ON CONFLICT (archiveid, mappingversion, sourcefingerprint)
           WHERE archiveid IS NOT NULL AND mappingversion IS NOT NULL AND sourcefingerprint IS NOT NULL
         DO UPDATE SET sourcehash = EXCLUDED.sourcehash
         RETURNING id, claimid AS ragclaimid, documentid, statuscode AS state, attempts, nextattemptat`,
        [
          this.options.writeUserId,
          sourceClaimId,
          LOCAL_PARSER_CODE,
          this.options.embeddingModel,
          this.options.embeddingDimensions,
          sourceArchiveId,
          mappingVersion,
          sourceFingerprint,
          sourceHash,
        ],
      );
      await client.query('COMMIT');
      return toJob(result.rows[0], false);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw databaseError(error, 'Could not create ingestion run');
    } finally {
      client.release();
    }
  }

  /**
   * `includeFailed` lets a terminal FAILED run be picked up again. The batch
   * worker leaves those alone by design, but without this an interactive
   * re-submit is refused forever: the run row survives, so the operator can
   * never retry the same document even after the cause is fixed. COMPLETED is
   * never reclaimed — that is the idempotence guarantee.
   */
  async claimJob(jobId: number, includeFailed = false): Promise<JobRecord> {
    const claimable = includeFailed ? ['PENDING', 'RETRY_WAIT', 'FAILED'] : ['PENDING', 'RETRY_WAIT'];
    const result = await this.pool.query<JobRow>(
      `UPDATE ${this.table('ingestionrun')}
       SET statuscode = 'PARSING', attempts = attempts + 1,
           processingstartedat = now(), startedat = now(),
           errormessage = NULL
       WHERE id = $1 AND statuscode = ANY($2::text[])
         AND (nextattemptat IS NULL OR nextattemptat <= now())
       RETURNING id, claimid AS ragclaimid, documentid, statuscode AS state, attempts, nextattemptat`,
      [jobId, claimable],
    );
    if (result.rows[0]) return toJob(result.rows[0], true);
    const current = await this.pool.query<JobRow>(
      `SELECT id, claimid AS ragclaimid, documentid, statuscode AS state, attempts, nextattemptat
       FROM ${this.table('ingestionrun')} WHERE id = $1`,
      [jobId],
    );
    return toJob(current.rows[0], false);
  }

  async markChunking(jobId: number, pageCount: number, markdownFullText: string, parseDurationMs: number): Promise<void> {
    await this.updateRun(
      `statuscode = 'CHUNKING', pagecount = $2, markdownfulltext = $3, parsedurationms = $4`,
      [jobId, pageCount, markdownFullText, parseDurationMs],
    );
  }

  async markEmbedding(jobId: number, chunkCount: number): Promise<void> {
    await this.updateRun(`statuscode = 'EMBEDDING', chunkcount = $2`, [jobId, chunkCount]);
  }

  async failJob(jobId: number, state: 'RETRY_WAIT' | 'FAILED', error: { code: string; message: string }, nextAttemptAt?: Date): Promise<void> {
    await this.updateRun(
      `statuscode = $2, errormessage = $3, nextattemptat = $4`,
      [jobId, state, `${error.code}: ${error.message}`, nextAttemptAt ?? null],
    );
  }

  async persistDocument(input: Parameters<RagStore['persistDocument']>[0]): Promise<PersistedDocument> {
    if (!input.chunks.length || input.chunks.length !== input.embeddings.length || input.embeddings.some((item) => item.length !== input.embeddingDimensions || !item.every(Number.isFinite))) {
      throw new ServiceError('Chunks and configured embedding dimensions do not agree', 'ollama', false);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [SOURCE_LOCK]);
      const existing = await client.query<{ id: number | string; sourcefingerprint: string | null }>(
        `SELECT id, sourcefingerprint FROM ${this.table('document')} WHERE archiveid = $1 AND sha256 = $2`,
        [input.sourceArchiveId, input.contentHash],
      );
      let documentId: number;
      if (existing.rows[0]) {
        documentId = Number(existing.rows[0].id);
        if (existing.rows[0].sourcefingerprint === input.sourceFingerprint) {
          // The same bytes read the same way. Nothing to replace.
          await this.completeRunInTransaction(client, input.jobId, documentId, input.completion);
          await client.query('COMMIT');
          return { id: documentId, ragDocumentId: documentId, alreadyExisted: true };
        }
        // Same bytes, different fingerprint: another OCR engine (or mapping
        // version) just read this file. Its text has to replace what retrieval
        // sees, otherwise re-running OCR would change only the text shown in the
        // drawer while chat kept answering from the previous engine's chunks.
        // ponytail: one document row per (archiveid, sha256) still, so this is a
        // replacement, not a second copy — the engines cannot be queried side by
        // side. Widen ux_document_archive_sha256 to include sourcefingerprint if
        // they ever have to be.
        await client.query(
          `DELETE FROM ${this.table('documentchunkpage')}
           WHERE documentchunkid IN (SELECT id FROM ${this.table('documentchunk')} WHERE documentid = $1)`,
          [documentId],
        );
        await client.query(`DELETE FROM ${this.table('documentchunk')} WHERE documentid = $1`, [documentId]);
        await client.query(`DELETE FROM ${this.table('documentpage')} WHERE documentid = $1`, [documentId]);
        await client.query(`DELETE FROM ${this.table('documentfield')} WHERE documentid = $1`, [documentId]);
        await client.query(
          `UPDATE ${this.table('document')} SET mappingversion = $2, sourcefingerprint = $3 WHERE id = $1`,
          [documentId, input.mappingVersion, input.sourceFingerprint],
        );
      } else {
        const inserted = await client.query<{ id: number | string }>(
          `INSERT INTO ${this.table('document')} (
             createuserid, claimid, filename, originalfilename, mimetype, sizebytes, sha256, storagepath,
             archiveid, mappingversion, sourcefingerprint
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [this.options.writeUserId, input.ragClaimId, input.sourceName, input.sourceName, input.sourceMimeType, input.sourceSizeBytes, input.contentHash, input.sourceStoragePath, input.sourceArchiveId, input.mappingVersion, input.sourceFingerprint],
        );
        documentId = Number(inserted.rows[0]!.id);
      }

      const pageIds = new Map<number, number>();
      for (const page of input.pages) {
        const pageRow = await client.query<{ id: number | string }>(
          `INSERT INTO ${this.table('documentpage')} (documentid, pagenumber, ocrtext, contenthash)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [documentId, page.pageIndex, page.text, contentHash(page.text)],
        );
        pageIds.set(page.pageIndex, Number(pageRow.rows[0]!.id));
      }

      // Structured answers live beside the pages rather than inside them: the
      // page text is what retrieval reads, this is what an underwriting rule
      // reads. Same transaction, so a document is never half-answered.
      for (const answer of input.answers ?? []) {
        await client.query(
          `INSERT INTO ${this.table('documentfield')} (documentid, pagenumber, label, questiontext, kind, value, confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (documentid, pagenumber, label, questiontext) DO UPDATE
             SET kind = EXCLUDED.kind, value = EXCLUDED.value, confidence = EXCLUDED.confidence`,
          [documentId, answer.page, answer.label, answer.text, answer.kind, answer.value, answer.confidence ?? null],
        );
      }

      for (let position = 0; position < input.chunks.length; position += 1) {
        const chunk = input.chunks[position];
        const vector = input.embeddings[position];
        if (!chunk || !vector || !pageIds.has(chunk.pageStart)) {
          throw new ServiceError('Chunk refers to a missing rendered page', 'configuration', false);
        }
        const chunkRow = await client.query<{ id: number | string }>(
          `INSERT INTO ${this.table('documentchunk')} (
             createuserid, ingestionrunid, documentid, claimid, parsercode, chunkindex,
             tokencount, charcount, contenttext, contentembedding
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector) RETURNING id`,
          [this.options.writeUserId, input.jobId, documentId, input.ragClaimId, LOCAL_PARSER_CODE, chunk.index, tokenCount(chunk.content), chunk.content.length, chunk.content, vectorLiteral(vector)],
        );
        const chunkId = Number(chunkRow.rows[0]!.id);
        for (let page = chunk.pageStart; page <= chunk.pageEnd; page += 1) {
          const pageId = pageIds.get(page);
          if (pageId) {
            await client.query(
              `INSERT INTO ${this.table('documentchunkpage')} (documentchunkid, documentpageid) VALUES ($1,$2)`,
              [chunkId, pageId],
            );
          }
        }
      }
      await this.completeRunInTransaction(client, input.jobId, documentId, input.completion);
      await client.query('COMMIT');
      return { id: documentId, ragDocumentId: documentId, alreadyExisted: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw databaseError(error, 'PostgreSQL persistence failed');
    } finally {
      client.release();
    }
  }

  /**
   * Nearest chunks for a query vector, restricted to the caller's documents.
   *
   * The ANN scan is isolated in `hits` so it can use the HNSW index before the
   * page join widens the row set. `parsercode` is not optional: the index in
   * migrations/001_rag_store.sql is partial on it, and omitting the predicate
   * silently degrades this into a sequential scan over every parser's vectors.
   */
  async searchChunks(embedding: number[], documentIds: number[], topK: number): Promise<ChunkHit[]> {
    if (embedding.length !== this.options.embeddingDimensions || !embedding.every(Number.isFinite)) {
      throw new ServiceError('Query embedding does not match the configured dimensions', 'ollama', false);
    }
    const ids = documentIds.filter((value) => Number.isSafeInteger(value) && value > 0);
    if (!ids.length) return [];
    const limit = Number.isSafeInteger(topK) && topK > 0 ? Math.min(topK, 100) : 8;

    const result = await this.pool.query<ChunkHitRow>(
      `WITH hits AS (
         SELECT c.id, c.documentid, c.chunkindex, c.contenttext,
                c.contentembedding <=> $1::vector AS distance
         FROM ${this.table('documentchunk')} c
         WHERE c.parsercode = $2 AND c.documentid = ANY($3::int[])
         ORDER BY c.contentembedding <=> $1::vector
         LIMIT $4
       )
       SELECT h.documentid, h.chunkindex, h.contenttext, h.distance,
              COALESCE(MIN(p.pagenumber), 0) AS pagestart,
              COALESCE(MAX(p.pagenumber), 0) AS pageend
       FROM hits h
       LEFT JOIN ${this.table('documentchunkpage')} cp ON cp.documentchunkid = h.id
       LEFT JOIN ${this.table('documentpage')} p ON p.id = cp.documentpageid
       GROUP BY h.id, h.documentid, h.chunkindex, h.contenttext, h.distance
       ORDER BY h.distance`,
      [vectorLiteral(embedding), LOCAL_PARSER_CODE, ids, limit],
    ).catch((error: unknown) => {
      throw databaseError(error, 'Chunk search failed');
    });

    return result.rows.map((row) => ({
      documentId: Number(row.documentid),
      chunkIndex: Number(row.chunkindex),
      pageStart: Number(row.pagestart),
      pageEnd: Number(row.pageend),
      content: row.contenttext,
      distance: Number(row.distance),
    }));
  }

  /** Re-attaching an already-ingested document skips OCR, so its stored text is read back instead. */
  async getDocumentPages(documentId: number): Promise<TextPage[]> {
    if (!Number.isSafeInteger(documentId) || documentId < 1) return [];
    const result = await this.pool.query<{ pagenumber: number | string; ocrtext: string }>(
      `SELECT pagenumber, ocrtext FROM ${this.table('documentpage')} WHERE documentid = $1 ORDER BY pagenumber`,
      [documentId],
    );
    return result.rows.map((row) => ({ pageIndex: Number(row.pagenumber), text: row.ocrtext }));
  }

  /**
   * How long this document took to process, from the newest run that recorded a
   * duration. Re-attaching an already-indexed document skips the work, so the
   * board would otherwise show the few milliseconds the skip itself took.
   */
  async getDocumentDurationMs(documentId: number): Promise<number | null> {
    if (!Number.isSafeInteger(documentId) || documentId < 1) return null;
    const result = await this.pool.query<{ totaldurationms: number | string }>(
      `SELECT totaldurationms FROM ${this.table('ingestionrun')}
       WHERE documentid = $1 AND totaldurationms IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [documentId],
    );
    const stored = Number(result.rows[0]?.totaldurationms);
    return Number.isFinite(stored) ? stored : null;
  }

  /**
   * Maps a TALDAR entity to its rag.claim scope id, creating the row on first
   * sight. The returned id is a surrogate: it is deliberately NOT the entity id,
   * because entity ids are only unique within their own type and rag.claim.id is
   * a single primary key shared by all four types.
   */
  async resolveScope(objectType: string, objectId: number, label: string): Promise<number> {
    if (!objectType.trim()) throw new ServiceError('objectType is required', 'configuration', false);
    if (!Number.isSafeInteger(objectId) || objectId < 1) throw new ServiceError('objectId must be a positive integer', 'configuration', false);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialised against concurrent first-sights of the same entity; the
      // partial unique index is the backstop if two workers still race.
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCOPE_LOCK]);
      const existing = await client.query<{ id: number | string }>(
        `SELECT id FROM ${this.table('claim')} WHERE objecttype = $1 AND objectid = $2`,
        [objectType, objectId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return Number(existing.rows[0].id);
      }

      // claimnumber is NOT NULL, so it carries the record's display name from
      // the UI rather than a fabricated claim number.
      const created = await client.query<{ id: number | string }>(
        `INSERT INTO ${this.table('claim')} (createuserid, claimnumber, objecttype, objectid)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [this.options.writeUserId, label.slice(0, 100) || `${objectType} ${objectId}`, objectType, objectId],
      );
      await client.query('COMMIT');
      return Number(created.rows[0]!.id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw databaseError(error, 'Could not resolve the RAG scope');
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async updateRun(assignments: string, values: unknown[]): Promise<void> {
    await this.pool.query(`UPDATE ${this.table('ingestionrun')} SET ${assignments} WHERE id = $1`, values);
  }

  private async completeRunInTransaction(
    client: PoolClient,
    jobId: number,
    documentId: number,
    completion: Parameters<RagStore['persistDocument']>[0]['completion'],
  ): Promise<void> {
    // totaldurationms is GENERATED ALWAYS AS (completedat - startedat) and rejects
    // a direct write, so completedat is set instead and the database derives it.
    await client.query(
      `UPDATE ${this.table('ingestionrun')}
       SET statuscode = 'COMPLETED', documentid = $2,
           processingcompletedat = now(), completedat = now(),
           pagecount = $3, chunkcount = $4, parsedurationms = $5, embeddingdurationms = $6,
           nextattemptat = NULL, errormessage = NULL
       WHERE id = $1`,
      [jobId, documentId, completion.pageCount, completion.chunkCount, completion.parseDurationMs, completion.embedDurationMs],
    );
  }

  private async assertColumns(table: string, columns: readonly string[]): Promise<void> {
    const result = await this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [RAG_SCHEMA, table],
    );
    const actual = new Set(result.rows.map((row) => row.column_name.toLowerCase()));
    const absent = columns.filter((column) => !actual.has(column));
    if (absent.length) throw new ServiceError(`RAG preflight: ${RAG_SCHEMA}.${table} is missing ${absent.join(', ')}`, 'preflight', false);
  }

  private async assertClaimExists(claimId: number, client: PoolClient): Promise<void> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${this.table('claim')} WHERE id = $1) AS exists`,
      [claimId],
    );
    if (!result.rows[0]?.exists) {
      throw new ServiceError(`Source claim ${claimId} does not exist in rag.claim`, 'source_not_found', false);
    }
  }

  private table(table: string): string {
    return quotePostgresRelation(RAG_SCHEMA, table);
  }

}

interface ChunkHitRow {
  documentid: number | string;
  chunkindex: number | string;
  contenttext: string;
  distance: number | string;
  pagestart: number | string;
  pageend: number | string;
}

interface JobRow {
  id: number | string;
  ragclaimid: number | string;
  documentid: number | string | null;
  state: IngestionJobState;
  attempts: number | string;
  nextattemptat: Date | null;
}

function toJob(row: JobRow | undefined, claimed: boolean): JobRecord {
  if (!row) throw new ServiceError('Ingestion run was not returned by PostgreSQL', 'database', true);
  return {
    id: Number(row.id),
    ragClaimId: Number(row.ragclaimid),
    state: row.state,
    attempts: Number(row.attempts),
    claimed,
    ...(row.documentid !== null ? { documentId: Number(row.documentid) } : {}),
    ...(row.nextattemptat ? { nextAttemptAt: row.nextattemptat } : {}),
  };
}

function vectorLiteral(value: number[]): string {
  return `[${value.join(',')}]`;
}

function tokenCount(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

function databaseError(error: unknown, fallback: string): ServiceError {
  if (error instanceof ServiceError) return error;
  const code = (error as { code?: unknown })?.code;
  return new ServiceError(error instanceof Error ? error.message : fallback, 'database', code === '40001' || code === '40P01' || code === '57P01');
}
