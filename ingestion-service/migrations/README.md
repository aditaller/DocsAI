# PostgreSQL RAG-store migration

Run `001_rag_store.sql` once against the dedicated PostgreSQL RAG database:

```powershell
psql $env:POSTGRES_CONNECTION_STRING -f migrations/001_rag_store.sql
```

The migration extends the existing `rag.document`, `rag.documentchunk`, and
`rag.ingestionrun` relations with source traceability and retry-status fields while
preserving the actual existing claim/document/chunk/run columns. It adds the
`rag.documentpage` / `rag.documentchunkpage` page relationships, preflight history,
and a coordination allocator. It also creates a separate partial HNSW index for
`parsercode = 'OLLAMA_QWEN3_6_LOCAL'`; it does not rely on AZURE_DI or
MARKITDOWN indexes.

The index assumes the existing, DBA-confirmed `rag.documentchunk.contentembedding`
vector and `parsercode` columns. It also makes `rag.ingestionrun.documentid`
nullable because the run lifecycle now starts before the OCR result has been written
to `rag.document`. Startup preflight checks the inspected `rag.document`,
`rag.documentchunk`, and `rag.ingestionrun` base columns plus every column added by
this migration before writes. The deployment's
`EMBEDDING_DIMENSIONS` must match the actual local qwen3 embedding vector size.
