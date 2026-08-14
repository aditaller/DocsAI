import { Pool, type PoolClient } from 'pg';

import { contentHash } from './chunker.js';
import { quotePostgresIdentifier, quotePostgresRelation } from './config.js';
import { ServiceError } from './errors.js';
import type { IngestionJobState, TextChunk, TextPage } from './types.js';

const ALLOCATOR_LOCK = 161803399;
const SOURCE_LOCK = 271828182;
const OLLAMA_PARSER_CODE = 'OLLAMA_QWEN3_6_LOCAL';
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
  claimJob(jobId: number): Promise<JobRecord>;
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
  claimExists(claimId: number): Promise<boolean>;
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
      this.assertColumns('rag_integer_allocator', ['allocator_name', 'next_value']),
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
      `INSERT INTO ${this.table('ingestion_preflight_run')} (id, mappingversion, succeeded, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [await this.allocate('ingestion_preflight_run'), mappingVersion, succeeded, JSON.stringify(detail)],
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
           id, createuserid, documentid, claimid, parsercode, embeddingmodel, embeddingdims, statuscode,
           archiveid, mappingversion, sourcefingerprint, sourcehash, attempts
         )
         VALUES ($1, $2, NULL, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10, 0)
         ON CONFLICT (archiveid, mappingversion, sourcefingerprint)
           WHERE archiveid IS NOT NULL AND mappingversion IS NOT NULL AND sourcefingerprint IS NOT NULL
         DO UPDATE SET sourcehash = EXCLUDED.sourcehash
         RETURNING id, claimid AS ragclaimid, documentid, statuscode AS state, attempts, nextattemptat`,
        [
          await this.allocate('ingestionrun', client),
          this.options.writeUserId,
          sourceClaimId,
          OLLAMA_PARSER_CODE,
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

  async claimJob(jobId: number): Promise<JobRecord> {
    const result = await this.pool.query<JobRow>(
      `UPDATE ${this.table('ingestionrun')}
       SET statuscode = 'PARSING', attempts = attempts + 1, processingstartedat = now(),
           errormessage = NULL
       WHERE id = $1 AND statuscode IN ('PENDING', 'RETRY_WAIT')
         AND (nextattemptat IS NULL OR nextattemptat <= now())
       RETURNING id, claimid AS ragclaimid, documentid, statuscode AS state, attempts, nextattemptat`,
      [jobId],
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
      const existing = await client.query<{ id: number | string }>(
        `SELECT id FROM ${this.table('document')} WHERE archiveid = $1 AND sha256 = $2`,
        [input.sourceArchiveId, input.contentHash],
      );
      if (existing.rows[0]) {
        const documentId = Number(existing.rows[0].id);
        await this.completeRunInTransaction(client, input.jobId, documentId, input.completion);
        await client.query('COMMIT');
        return { id: documentId, ragDocumentId: documentId, alreadyExisted: true };
      }

      const documentId = await this.allocate('document', client);
      await client.query(
        `INSERT INTO ${this.table('document')} (
           id, createuserid, claimid, filename, originalfilename, mimetype, sizebytes, sha256, storagepath,
           archiveid, mappingversion, sourcefingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [documentId, this.options.writeUserId, input.ragClaimId, input.sourceName, input.sourceName, input.sourceMimeType, input.sourceSizeBytes, input.contentHash, input.sourceStoragePath, input.sourceArchiveId, input.mappingVersion, input.sourceFingerprint],
      );

      const pageIds = new Map<number, number>();
      for (const page of input.pages) {
        const pageId = await this.allocate('documentpage', client);
        await client.query(
          `INSERT INTO ${this.table('documentpage')} (id, documentid, pagenumber, ocrtext, contenthash)
           VALUES ($1,$2,$3,$4,$5)`,
          [pageId, documentId, page.pageIndex, page.text, contentHash(page.text)],
        );
        pageIds.set(page.pageIndex, pageId);
      }

      for (let position = 0; position < input.chunks.length; position += 1) {
        const chunk = input.chunks[position];
        const vector = input.embeddings[position];
        if (!chunk || !vector || !pageIds.has(chunk.pageStart)) {
          throw new ServiceError('Chunk refers to a missing rendered page', 'configuration', false);
        }
        const chunkId = await this.allocate('documentchunk', client);
        await client.query(
          `INSERT INTO ${this.table('documentchunk')} (
             id, createuserid, ingestionrunid, documentid, claimid, parsercode, chunkindex,
             tokencount, charcount, contenttext, contentembedding
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)`,
          [chunkId, this.options.writeUserId, input.jobId, documentId, input.ragClaimId, OLLAMA_PARSER_CODE, chunk.index, tokenCount(chunk.content), chunk.content.length, chunk.content, vectorLiteral(vector)],
        );
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
      [vectorLiteral(embedding), OLLAMA_PARSER_CODE, ids, limit],
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

  /** Surfaced for the health check so a missing claim is reported before ingest, not mid-batch. */
  async claimExists(claimId: number): Promise<boolean> {
    if (!Number.isSafeInteger(claimId) || claimId < 1) return false;
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${this.table('claim')} WHERE id = $1) AS exists`,
      [claimId],
    );
    return result.rows[0]?.exists === true;
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
    await client.query(
      `UPDATE ${this.table('ingestionrun')}
       SET statuscode = 'COMPLETED', documentid = $2, processingcompletedat = now(),
           pagecount = $3, chunkcount = $4, parsedurationms = $5, embeddingdurationms = $6,
           totaldurationms = $7, nextattemptat = NULL, errormessage = NULL
       WHERE id = $1`,
      [jobId, documentId, completion.pageCount, completion.chunkCount, completion.parseDurationMs, completion.embedDurationMs, completion.totalDurationMs],
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

  private async allocate(table: string, client?: PoolClient): Promise<number> {
    const connection = client ?? await this.pool.connect();
    const ownsConnection = !client;
    try {
      if (ownsConnection) await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock($1)', [ALLOCATOR_LOCK]);
      const next = await connection.query<{ value: number | string }>(
        `SELECT COALESCE(MAX(${quotePostgresIdentifier('id')}), 0) + 1 AS value FROM ${this.table(table)}`,
      );
      const value = Number(next.rows[0]?.value);
      if (!Number.isSafeInteger(value) || value < 1) throw new ServiceError(`Cannot allocate ${table} ID`, 'database', false);
      await connection.query(
        `INSERT INTO ${this.table('rag_integer_allocator')} (allocator_name, next_value)
         VALUES ($1, $2)
         ON CONFLICT (allocator_name) DO UPDATE
         SET next_value = GREATEST(${this.table('rag_integer_allocator')}.next_value, EXCLUDED.next_value)`,
        [table, value + 1],
      );
      if (ownsConnection) await connection.query('COMMIT');
      return value;
    } catch (error) {
      if (ownsConnection) await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if (ownsConnection) connection.release();
    }
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
