-- REVIEW BEFORE APPLYING. This migration deliberately extends the existing
-- ragdb relations; it does not replace claim/document/documentchunk/etc.
-- It assumes the already documented existing HNSW names: documentchunk.contentembedding
-- and documentchunk.parsercode. The service validates the inspected base names
-- and every extension column at runtime before it writes.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS rag;

CREATE TABLE IF NOT EXISTS rag.rag_integer_allocator (
  allocator_name text PRIMARY KEY,
  next_value integer NOT NULL CHECK (next_value > 0)
);

ALTER TABLE rag.document
  ADD COLUMN IF NOT EXISTS archiveid bigint,
  ADD COLUMN IF NOT EXISTS mappingversion text,
  ADD COLUMN IF NOT EXISTS sourcefingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_document_archive_sha256
  ON rag.document (archiveid, sha256)
  WHERE archiveid IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_document_archive_mapping
  ON rag.document (archiveid, mappingversion);

CREATE TABLE IF NOT EXISTS rag.documentpage (
  id integer PRIMARY KEY,
  documentid integer NOT NULL REFERENCES rag.document(id) ON DELETE CASCADE,
  pagenumber integer NOT NULL CHECK (pagenumber > 0),
  ocrtext text NOT NULL,
  contenthash char(64) NOT NULL,
  createdat timestamptz NOT NULL DEFAULT now(),
  UNIQUE (documentid, pagenumber)
);

CREATE TABLE IF NOT EXISTS rag.documentchunkpage (
  documentchunkid integer NOT NULL REFERENCES rag.documentchunk(id) ON DELETE CASCADE,
  documentpageid integer NOT NULL REFERENCES rag.documentpage(id) ON DELETE CASCADE,
  PRIMARY KEY (documentchunkid, documentpageid)
);

ALTER TABLE rag.ingestionrun
  ADD COLUMN IF NOT EXISTS archiveid bigint,
  ADD COLUMN IF NOT EXISTS mappingversion text,
  ADD COLUMN IF NOT EXISTS sourcefingerprint text,
  ADD COLUMN IF NOT EXISTS sourcehash char(64),
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nextattemptat timestamptz,
  ADD COLUMN IF NOT EXISTS processingstartedat timestamptz,
  ADD COLUMN IF NOT EXISTS processingcompletedat timestamptz,
  ADD COLUMN IF NOT EXISTS pagecount integer,
  ADD COLUMN IF NOT EXISTS chunkcount integer,
  ADD COLUMN IF NOT EXISTS markdownfulltext text,
  ADD COLUMN IF NOT EXISTS parsedurationms integer,
  ADD COLUMN IF NOT EXISTS embeddingdurationms integer,
  ADD COLUMN IF NOT EXISTS totaldurationms integer,
  ADD COLUMN IF NOT EXISTS errormessage text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'rag'
      AND table_name = 'ingestionrun'
      AND column_name = 'documentid'
      AND is_nullable = 'NO'
  ) THEN
    EXECUTE 'ALTER TABLE rag.ingestionrun ALTER COLUMN documentid DROP NOT NULL';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ingestionrun_archive_fingerprint
  ON rag.ingestionrun (archiveid, mappingversion, sourcefingerprint)
  WHERE archiveid IS NOT NULL AND mappingversion IS NOT NULL AND sourcefingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ingestionrun_work
  ON rag.ingestionrun (statuscode, nextattemptat);

CREATE TABLE IF NOT EXISTS rag.ingestion_preflight_run (
  id integer PRIMARY KEY,
  mappingversion text NOT NULL,
  succeeded boolean NOT NULL,
  detail jsonb NOT NULL,
  createdat timestamptz NOT NULL DEFAULT now()
);

-- This is intentionally separate from AZURE_DI and MARKITDOWN partial indexes.
CREATE INDEX IF NOT EXISTS ix_documentchunk_embedding_ollama_qwen_local_hnsw
  ON rag.documentchunk USING hnsw (contentembedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE parsercode = 'OLLAMA_QWEN3_6_LOCAL';
