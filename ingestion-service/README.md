# Local archive → RAG ingestion service

This service ingests image and PDF content from the TALDAR SQL Server archive
into a local PostgreSQL/pgvector RAG store. It never writes to SQL Server, and it
does not modify the frontend's cloud/OCR configuration.

It runs in two ways over the same pipeline:

- **Batch CLI** (`npm run ingest`) — pulls source rows from SQL Server on a page
  of archive IDs. This is the original mode and is unchanged.
- **HTTP service** (`npm run serve`) — a loopback-only surface the Angular app
  calls when the operator selects **Use Local RAG**. The caller supplies the
  bytes, so SQL Server is never touched. See [Local HTTP API](#local-http-api).

## Security and identity model

- The source document identity is TALDAR `gnr.archive.archiveid` (the view may
  expose it as `archiveid`; the runtime mapping can use another verified numeric
  column). The pipeline is explicitly **claim-based** and also requires a
  verified numeric source claim ID column (for example a claim-scoped `objectid`
  column or a dedicated claim id projection).
- `RAG_WRITE_USER_ID` is required because the actual local `rag.document`,
  `rag.documentchunk`, and `rag.ingestionrun` rows all require a
  valid existing integer `createuserid`.
- All SQL identifiers come from a validated explicit mapping. All source IDs,
  limits, and values are query parameters. Do not copy untrusted identifier text
  into the mapping.
- The service accepts binary data from a configured SQL binary column or, only
  when `contentColumn` is `null`, a `fullpath` contained below
  `ARCHIVE_FILE_ROOT`. It rejects path traversal, non-PDF/image magic bytes,
  oversized input, excessive PDF pages, and non-loopback Ollama endpoints.
- OCR text and secrets are never logged. Error messages are sanitized before
  they enter PostgreSQL run records.

## Setup

1. Install [Ollama](https://ollama.com/) locally and pull the configured vision
   and embedding models, for example:

   ```powershell
   ollama pull qwen3.6:35b-a3b
   ollama pull qwen3-embedding:4b
   ```

2. Install Poppler locally so `pdftoppm` is available for PDF inputs. A
   Ghostscript-based wrapper is acceptable only when it has the same one-PNG-per-page
   behavior and is configured as `PDFTOPPM_PATH`.
3. Create a least-privilege SQL Server archive reader and PostgreSQL RAG writer.
4. Copy `.env.example` to `.env`; set connection strings and replace the
   mapping with the real, verified source columns. `claimIdColumn` must resolve
   to the numeric, existing local `rag.claim.id` that documents and chunks will
   reference. Prefer a SQL binary `contentColumn`. If source revisions are
   available, configure `modifiedAtColumn` (rowversion or modified time) for cheap
   source-aware idempotence.
5. Review the migration against the deployed `rag` schema, especially its documented
   `documentchunk.contentembedding` / `parsercode` HNSW assumption and the
   `ingestionrun.documentid` nullability change, then run it:

   ```powershell
   psql $env:POSTGRES_CONNECTION_STRING -f migrations/001_rag_store.sql
   ```

6. Install and verify:

   ```powershell
   npm install
   npm run typecheck
   npm test
   npm run preflight
   ```

`preflight` checks connection/access and that every mapped GNR source column, the
inspected ragdb base columns, and the migration's extension columns are present
before work is started. It records the result in PostgreSQL. The RAG base names are
deliberately fixed and verified at runtime: there is no `RAG_MAPPING_JSON` because
the service must not guess aliases for those local tables.

## Commands

```powershell
# Validate both databases and the schema mapping
npm run preflight

# Preview up to 20 source records after archive ID 0; does not call Ollama or write RAG data
npm run ingest -- --limit 20 --after-id 0 --dry-run

# Ingest one known TALDAR archive ID
npm run ingest -- --archive-id 12345

# Process due retries first, then the next source page
npm run ingest -- --limit 20 --after-id 0
```

The worker creates a `PENDING` run, claims it as `PARSING`, advances it through
`CHUNKING` and `EMBEDDING`, then writes the final `COMPLETED` run/document/chunks
atomically. It skips a completed identical fingerprint, and retries transient
network/database/Ollama failures with bounded exponential backoff (`RETRY_WAIT`).
Validation, unsupported input, and exhausted retries are terminal `FAILED` runs.
Due retries are claimed before new `--after-id` work whenever the batch command
is invoked.

For each new document, page, chunk, or ingestion run, PostgreSQL obtains a
transaction-scoped advisory lock and allocates its integer ID from `MAX(id)+1` while
that lock is held. The source claim ID is used directly as the existing rag claim
ID; the pipeline does not create or infer claim records. This protects ID-less
legacy tables from concurrent workers.
Each OCR page is stored in `rag.documentpage`; `rag.documentchunkpage` records every
page covered by a chunk. Documents are idempotent by source archive + content hash
(`archiveid` + `sha256`), so re-seeing the same bytes reuses the same document row.

## Local HTTP API

```powershell
npm run serve   # binds 127.0.0.1:LOCAL_API_PORT (default 11500)
```

`OLLAMA_CHAT_MODEL` is required for this mode and the process refuses to start
without it. The Angular dev server reaches these routes through the `/api/local`
rule in the app's `proxy.conf.json`.

| Route | Purpose |
| --- | --- |
| `GET /api/local/health` | Reports PostgreSQL reachability, Ollama reachability, any missing models, and — with `?claimId=` — whether that record exists in `rag.claim`. Drives whether the UI offers the mode at all. |
| `POST /api/local/ingest?archiveId=&claimId=&fileName=` | Raw bytes in the body. Renders, OCRs every page, chunks, embeds, and persists, then returns the per-page text. Identical bytes already indexed are reused rather than re-OCR'd. |
| `POST /api/local/chat` | `{ prompt, documentIds, topK? }` → embeds the prompt, retrieves the nearest chunks from those documents only, and answers from them with page citations. |

**This surface performs no authentication.** The `jwt` cookie the .NET API issues
is not validated here. It binds to `127.0.0.1` for that reason and must never be
exposed on a public interface or put behind a forwarding proxy.

Documents must already exist in `gnr.archive` (so they have an archive ID) and
their record must already exist in `rag.claim`. The health route reports the
latter so a missing claim is visible before ingestion rather than failing on the
foreign key mid-batch.

## Operational limitations

- PDF rendering uses the locally installed `pdftoppm`; Office formats are
  intentionally unsupported.
- OCR quality is determined by the selected local vision model. There is no
  remote fallback and no hosted endpoint.
- The source mapping must be validated against the deployed SQL Server schema;
  the example names (`objectid`, `filename`, `fullpath`) are frontend
  conventions, not a production contract.
- A source without `modifiedAtColumn` is read and hashed to decide idempotence.
  Configure a modification timestamp or rowversion to avoid that read for
  unchanged items.
- Pages are OCR'd serially to bound local RAM, so a long PDF takes minutes
  through the HTTP route and the caller sees no per-page progress until it
  finishes. Streaming progress would need SSE.
- Changing `OLLAMA_EMBEDDING_MODEL` invalidates every stored vector. There is no
  migration for that; treat it as a re-ingest.
