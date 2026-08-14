import { promises as fs } from 'node:fs';
import path from 'node:path';
import sql from 'mssql';

import { type ArchiveMapping, quoteSqlServerIdentifier, quoteSqlServerRelation } from './config.js';
import { ServiceError } from './errors.js';
import type { ArchiveRecord, SourceFile } from './types.js';

export interface ArchivePreflight {
  relation: string;
  configuredColumns: string[];
  availableColumns: string[];
  missingColumns: string[];
}

export interface ArchiveReader {
  preflight(): Promise<ArchivePreflight>;
  listAfter(afterId: number, limit: number): Promise<ArchiveRecord[]>;
  getById(archiveId: number): Promise<SourceFile>;
  close(): Promise<void>;
}

export class SqlServerArchiveReader implements ArchiveReader {
  private pool: sql.ConnectionPool | undefined;

  constructor(
    private readonly options: {
      connectionString: string;
      mapping: ArchiveMapping;
      maxSourceBytes: number;
      archiveFileRoot?: string;
    },
  ) {}

  async preflight(): Promise<ArchivePreflight> {
    const pool = await this.connect();
    const columnsResult = await pool
      .request()
      .input('schema', sql.NVarChar, this.options.mapping.schema)
      .input('relation', sql.NVarChar, this.options.mapping.relation)
      .query<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @relation`,
      );

    const availableColumns = columnsResult.recordset.map((row) => row.COLUMN_NAME);
    const available = new Set(availableColumns.map((column) => column.toLowerCase()));
    const configuredColumns = this.configuredColumns();
    const missingColumns = configuredColumns.filter((column) => !available.has(column.toLowerCase()));
    if (missingColumns.length === 0) {
      // This confirms the runtime role can access the mapped view/table without
      // transferring a document or interpolating a value.
      await pool.request().query(`SELECT TOP (0) ${this.selectList(true)} FROM ${this.relation()}`);
    }
    return {
      relation: `${this.options.mapping.schema}.${this.options.mapping.relation}`,
      configuredColumns,
      availableColumns,
      missingColumns,
    };
  }

  async listAfter(afterId: number, limit: number): Promise<ArchiveRecord[]> {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new ServiceError('Invalid archive paging arguments', 'configuration', false);
    }
    const result = await (await this.connect())
      .request()
      .input('afterId', sql.BigInt, afterId)
      .input('limit', sql.Int, limit)
      .query<Record<string, unknown>>(
        `SELECT TOP (@limit) ${this.selectList(false)}
         FROM ${this.relation()}
         WHERE ${this.column(this.options.mapping.idColumn)} > @afterId
         ORDER BY ${this.column(this.options.mapping.idColumn)} ASC`,
      );
    return result.recordset.map((row) => this.toArchiveRecord(row));
  }

  async getById(archiveId: number): Promise<SourceFile> {
    if (!Number.isSafeInteger(archiveId) || archiveId <= 0) {
      throw new ServiceError('Archive identity must be a positive safe integer', 'configuration', false);
    }
    const result = await (await this.connect())
      .request()
      .input('archiveId', sql.BigInt, archiveId)
      .query<Record<string, unknown>>(
        `SELECT ${this.selectList(true)}
         FROM ${this.relation()}
         WHERE ${this.column(this.options.mapping.idColumn)} = @archiveId`,
      );
    const row = result.recordset[0];
    if (!row) throw new ServiceError(`Archive ${archiveId} was not found`, 'source_not_found', false);

    const record = this.toArchiveRecord(row);
    let bytes: Buffer;
    if (this.options.mapping.contentColumn) {
      const value = row.archive_content;
      if (Buffer.isBuffer(value)) bytes = value;
      else if (value instanceof Uint8Array) bytes = Buffer.from(value);
      else throw new ServiceError(`Archive ${archiveId} has no binary content`, 'source_not_found', false);
    } else {
      if (!record.fullPath) throw new ServiceError(`Archive ${archiveId} has no configured file path`, 'source_not_found', false);
      bytes = await this.readArchivedPath(record.fullPath);
    }
    if (bytes.length === 0 || bytes.length > this.options.maxSourceBytes) {
      throw new ServiceError(`Archive ${archiveId} violates source byte limits`, 'source_limit', false);
    }
    return { ...record, bytes, mimeType: record.mimeType ?? 'application/octet-stream' };
  }

  async close(): Promise<void> {
    await this.pool?.close();
    this.pool = undefined;
  }

  private async connect(): Promise<sql.ConnectionPool> {
    if (!this.pool) {
      this.pool = await new sql.ConnectionPool(this.options.connectionString).connect();
    }
    return this.pool;
  }

  private relation(): string {
    return quoteSqlServerRelation(this.options.mapping.schema, this.options.mapping.relation);
  }

  private column(name: string): string {
    return quoteSqlServerIdentifier(name);
  }

  private configuredColumns(): string[] {
    const mapping = this.options.mapping;
    return [
      mapping.idColumn,
      mapping.claimIdColumn,
      mapping.fileNameColumn,
      mapping.mimeTypeColumn,
      mapping.contentColumn,
      mapping.fullPathColumn,
      mapping.modifiedAtColumn,
    ].filter((column): column is string => column !== null);
  }

  private selectList(includeContent: boolean): string {
    const mapping = this.options.mapping;
    const expressions = [
      `${this.column(mapping.idColumn)} AS archive_id`,
      `${this.column(mapping.claimIdColumn)} AS archive_claim_id`,
      `${this.column(mapping.fileNameColumn)} AS archive_name`,
      ...(mapping.mimeTypeColumn ? [`${this.column(mapping.mimeTypeColumn)} AS archive_mime_type`] : []),
      ...(mapping.fullPathColumn ? [`${this.column(mapping.fullPathColumn)} AS archive_full_path`] : []),
      ...(mapping.modifiedAtColumn ? [`CONVERT(nvarchar(128), ${this.column(mapping.modifiedAtColumn)}, 126) AS archive_revision`] : []),
      ...(includeContent && mapping.contentColumn ? [`${this.column(mapping.contentColumn)} AS archive_content`] : []),
    ];
    return expressions.join(', ');
  }

  private toArchiveRecord(row: Record<string, unknown>): ArchiveRecord {
    const archiveId = Number(row.archive_id);
    if (!Number.isSafeInteger(archiveId) || archiveId <= 0) {
      throw new ServiceError('Source returned an invalid archive identity', 'source_not_found', false);
    }
    const sourceClaimId = Number(row.archive_claim_id);
    if (!Number.isSafeInteger(sourceClaimId) || sourceClaimId <= 0) {
      throw new ServiceError(`Archive ${archiveId} has no valid numeric source claim identity`, 'source_not_found', false);
    }
    const fileName = String(row.archive_name ?? '').trim();
    if (!fileName) throw new ServiceError(`Archive ${archiveId} has no filename`, 'source_not_found', false);
    const mimeType = stringOrUndefined(row.archive_mime_type);
    const fullPath = stringOrUndefined(row.archive_full_path);
    const sourceRevision = stringOrUndefined(row.archive_revision);
    return {
      archiveId,
      sourceClaimId,
      fileName,
      ...(mimeType ? { mimeType } : {}),
      ...(fullPath ? { fullPath } : {}),
      ...(sourceRevision ? { sourceRevision } : {}),
    };
  }

  private async readArchivedPath(sourcePath: string): Promise<Buffer> {
    try {
      const root = this.options.archiveFileRoot;
      if (!root) throw new ServiceError('ARCHIVE_FILE_ROOT is not configured', 'configuration', false);
      const rootPath = await fs.realpath(path.resolve(root));
      const requestedPath = path.resolve(rootPath, sourcePath);
      const targetPath = await fs.realpath(requestedPath);
      const relative = path.relative(rootPath, targetPath);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ServiceError('Archive fullpath is outside ARCHIVE_FILE_ROOT', 'source_not_found', false);
      }
      const stat = await fs.stat(targetPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > this.options.maxSourceBytes) {
        throw new ServiceError('Archived path violates file limits', 'source_limit', false);
      }
      return fs.readFile(targetPath);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('Configured archive file could not be read', 'source_not_found', false);
    }
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}
