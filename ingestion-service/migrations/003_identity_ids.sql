-- REVIEW BEFORE APPLYING.
--
-- Every table that predates this service (claim, document, documentchunk,
-- ingestionrun, claimaggregate, querylog) declares its primary key as
-- GENERATED ALWAYS AS IDENTITY, which refuses an explicitly supplied id:
--
--   ERROR: cannot insert a non-DEFAULT value into column "id"
--
-- 001 created documentpage and ingestion_preflight_run with plain integer keys
-- instead, to suit the MAX(id)+1 allocator the service shipped with. That
-- allocator existed to serve ID-less legacy tables, which this database does not
-- have. Aligning the two new tables with the house style lets the writer use one
-- strategy everywhere and retires the allocator.
--
-- Safe on empty tables: the identity sequences start at 1. If either table has
-- rows when this runs, set each sequence past its current MAX(id) afterwards.

ALTER TABLE rag.documentpage
  ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

ALTER TABLE rag.ingestion_preflight_run
  ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY;

-- Only the retired allocator ever wrote here.
DROP TABLE IF EXISTS rag.rag_integer_allocator;
