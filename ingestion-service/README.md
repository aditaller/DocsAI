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
   ollama pull gpt-oss:20b
   ollama pull qwen3-embedding:0.6b
   ```

2. Install Poppler locally for PDF inputs — on Windows,
   `winget install --id oschwartz10612.Poppler -e`. Point `PDFTOPPM_PATH` at the
   absolute path of `pdftoppm`: that package puts it on `PATH` too, but a running
   `npm run serve` never picks up a `PATH` change. `pdftotext` is taken from the
   same directory, so both come from one setting. `GET /api/local/health` reports
   `pdftoppm` once it is reachable. A Ghostscript-based wrapper is acceptable only
   when it has the same one-PNG-per-page behavior.
3. For the `tesseract` engine, run a container with tesseract and the language
   data installed, and leave it up. It needs no published port and no mount —
   the service reaches it with `docker exec -i`:

   ```powershell
   docker exec tesseract-ocr tesseract --list-langs   # expect at least eng, heb
   ```

4. Create a least-privilege SQL Server archive reader and PostgreSQL RAG writer.
5. Copy `.env.example` to `.env`; set connection strings and replace the
   mapping with the real, verified source columns. `claimIdColumn` must resolve
   to the numeric, existing local `rag.claim.id` that documents and chunks will
   reference. Prefer a SQL binary `contentColumn`. If source revisions are
   available, configure `modifiedAtColumn` (rowversion or modified time) for cheap
   source-aware idempotence.
6. Review the migration against the deployed `rag` schema, especially its documented
   `documentchunk.contentembedding` / `parsercode` HNSW assumption and the
   `ingestionrun.documentid` nullability change, then run it:

   ```powershell
   psql $env:POSTGRES_CONNECTION_STRING -f migrations/001_rag_store.sql
   ```

7. Install and verify:

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
A run's fingerprint carries the OCR engine when it is not the original vision
model, so the same bytes read by tesseract are a separate run rather than a
skipped duplicate. When a run's fingerprint differs from the one recorded on the
document, its pages and chunks replace the stored ones — re-running OCR changes
what chat retrieves, not just what the UI displays.

## Local HTTP API

```powershell
npm run serve   # binds 127.0.0.1:LOCAL_API_PORT (default 11500)
```

`OLLAMA_CHAT_MODEL` is required for this mode and the process refuses to start
without it. The Angular dev server reaches these routes through the `/api/local`
rule in the app's `proxy.conf.json`.

| Route | Purpose |
| --- | --- |
| `GET /api/local/health` | Reports PostgreSQL reachability, Ollama reachability, any missing models, whether the tesseract container answers, and the configured default engine. Drives whether the UI offers the mode at all. Ollama gates `ok` on both engines: it embeds and answers even when tesseract reads the pages. |
| `POST /api/local/ingest?archiveId=&objectType=&objectId=&label=&fileName=&engine=` | Raw bytes in the body. Renders, OCRs every page, chunks, embeds, and persists, then returns the per-page text. `engine` is `tesseract-heb`, `tesseract-eng`, or `ollama`, and defaults to `LOCAL_OCR_ENGINE`. Identical bytes already indexed **by the same engine** are reused rather than re-OCR'd. |
| `POST /api/local/chat` | `{ prompt, documentIds, topK? }` → embeds the prompt, retrieves the nearest chunks from those documents only, and answers from them with page citations. |

**This surface performs no authentication.** The `jwt` cookie the .NET API issues
is not validated here. It binds to `127.0.0.1` for that reason and must never be
exposed on a public interface or put behind a forwarding proxy.

Documents must already exist in `gnr.archive` (so they have an archive ID). The
scope row in `rag.claim` is created on first ingest from `objectType`/`objectId`,
so no record has to be provisioned in advance.

## Operational limitations

- A PDF is read from its own text layer with `pdftotext` when every page carries
  one, which takes milliseconds and is exact. Only a scan reaches `pdftoppm` and
  an OCR engine. The test is all-or-nothing per document: one page thin enough to
  look scanned sends the whole file to OCR, which is slower but never silently
  stores a near-empty page. Office formats are intentionally unsupported.
- **Hebrew is not supported by the local vision models tested.** Measured against
  Azure Document Intelligence output for the same scan, `qwen3.6:35b-a3b` reached
  18% word recall and `qwen3-vl:4b` 4% (the latter degenerating into a repetition
  loop). Both produce fluent-looking Hebrew that is largely invented. Use the
  `tesseract-heb` engine for Hebrew; it is also faster than the vision model by
  roughly an order of magnitude.
- **Pick the tesseract engine that matches the document.** Languages are loaded,
  not detected, and every loaded language competes for each glyph. `tesseract-heb`
  (`heb+eng`) reads a Hebrew document including its Latin dates and amounts;
  dropping `eng` from that set turns `15/06/2025` into `5"` and `1,500.00` into
  `10-00`. `tesseract-eng` (`eng`) exists because the reverse is also true: an
  English document is read better with the Hebrew model unloaded.
- The tesseract engine shells out to `docker exec -i $TESSERACT_CONTAINER`, so
  the Docker CLI must be on this process's PATH and the container must be
  running. It needs no published port and no mount: the page image goes in on
  stdin and TSV comes back on stdout. Confidence is the mean of the per-word
  scores in that TSV; language is inferred from the script, since tesseract is
  told which languages to load rather than reporting what it found.
- `PDF_RENDER_DPI` is the one lever that matters to tesseract. It defaults to
  poppler's 150; 300 reads small Hebrew type appreciably better and costs the
  vision model extra image tokens.
- OCR quality is determined by the selected engine. There is no remote fallback
  and no hosted endpoint. A vision model will also invent text for a blank or
  near-blank page rather than returning nothing.
- Switching engines re-reads the pages and **replaces** what chat retrieves:
  `rag.document` still keeps one row per `(archiveid, sha256)`, so the second
  engine's pages, chunks and embeddings overwrite the first engine's under the
  same document ID. The two engines' text cannot be queried side by side; the
  most recent run wins. Widen `ux_document_archive_sha256` to include
  `sourcefingerprint` if both have to be retrievable at once.
- Model size is a poor predictor of speed here. `qwen3.6:35b-a3b` needs 23 GB and
  runs 42% on the CPU of a 16 GB card, yet is roughly four times faster than the
  3.3 GB `qwen3-vl:4b` that fits entirely in VRAM, because it is a Mixture-of-
  Experts with far fewer active parameters. Measure before assuming.
- Thinking-capable models (qwen3.6 among them) must not think during OCR: at
  Ollama's default 4096-token context they spend the entire output budget
  reasoning and return an empty transcription with `done_reason: "length"`. OCR
  requests therefore send `think: false`, and `OLLAMA_NUM_CTX` raises the window
  for both OCR and retrieval prompts.
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
