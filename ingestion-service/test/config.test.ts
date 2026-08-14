import assert from 'node:assert/strict';
import test from 'node:test';

import { SqlServerArchiveReader } from '../src/archive-reader.js';
import { loadConfig, quoteSqlServerIdentifier } from '../src/config.js';

const baseline = {
  SQLSERVER_CONNECTION_STRING: 'Server=localhost;Database=archive;User Id=reader;******',
  POSTGRES_CONNECTION_STRING: '******127.0.0.1/rag',
  ARCHIVE_MAPPING_JSON: JSON.stringify({
    version: 'test-v1',
    schema: 'gnr',
    relation: 'v_archive',
    idColumn: 'archiveid',
    claimIdColumn: 'claimid',
    fileNameColumn: 'filename',
    mimeTypeColumn: null,
    contentColumn: 'filebytes',
    fullPathColumn: null,
    modifiedAtColumn: 'modifieddate',
  }),
  RAG_WRITE_USER_ID: '7',
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  OLLAMA_OCR_MODEL: 'vision',
  OLLAMA_EMBEDDING_MODEL: 'embed',
  EMBEDDING_DIMENSIONS: '3',
};

test('configuration accepts a validated runtime archive mapping', () => {
  const config = loadConfig(baseline);
  assert.equal(config.archiveMapping.idColumn, 'archiveid');
  assert.equal(config.archiveMapping.claimIdColumn, 'claimid');
  assert.equal(config.embeddingDimensions, 3);
  assert.equal(config.ragWriteUserId, 7);
});

test('configuration requires the source claim mapping and RAG write identity', () => {
  const archiveMapping = JSON.parse(baseline.ARCHIVE_MAPPING_JSON);
  delete archiveMapping.claimIdColumn;
  assert.throws(() => loadConfig({ ...baseline, ARCHIVE_MAPPING_JSON: JSON.stringify(archiveMapping) }));
  const { RAG_WRITE_USER_ID: _writeUserId, ...withoutWriteUserId } = baseline;
  assert.throws(() => loadConfig(withoutWriteUserId));
});

test('configuration refuses non-local Ollama URLs', () => {
  assert.throws(() => loadConfig({ ...baseline, OLLAMA_BASE_URL: 'https://ollama.example.test' }), /loopback/);
  assert.throws(() => loadConfig({ ...baseline, OLLAMA_BASE_URL: 'http://localhost:11434' }), /loopback/);
});

test('SQL Server identifiers cannot carry SQL syntax', () => {
  assert.equal(quoteSqlServerIdentifier('archiveid'), '[archiveid]');
  assert.throws(() => quoteSqlServerIdentifier('archiveid; DROP TABLE x'), /Unsafe/);
});

test('preflight verifies read access to the configured binary content and claim columns', async () => {
  const queries: string[] = [];
  const request = {
    input: () => request,
    query: async (query: string) => {
      queries.push(query);
      if (query.includes('INFORMATION_SCHEMA.COLUMNS')) {
        return {
          recordset: ['archiveid', 'claimid', 'filename', 'filebytes', 'modifieddate'].map((COLUMN_NAME) => ({ COLUMN_NAME })),
        };
      }
      return { recordset: [] };
    },
  };
  const reader = new SqlServerArchiveReader({
    connectionString: baseline.SQLSERVER_CONNECTION_STRING,
    mapping: JSON.parse(baseline.ARCHIVE_MAPPING_JSON),
    maxSourceBytes: 1_024,
  });
  (reader as unknown as { pool: unknown }).pool = { request: () => request };

  await reader.preflight();

  assert.ok(queries.some((query) => query.includes('[claimid] AS archive_claim_id')));
  assert.ok(queries.some((query) => query.includes('[filebytes] AS archive_content')));
});
