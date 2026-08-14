import 'dotenv/config';

import http from 'node:http';

import { loadConfig } from './config.js';
import { sanitizeError, ServiceError, type ErrorCode } from './errors.js';
import { Logger } from './logger.js';
import { OllamaClient } from './ollama.js';
import { IngestionPipeline } from './pipeline.js';
import { PostgresRagStore, type ChunkHit } from './rag-store.js';
import { ImagePageRenderer, PopplerPdfRenderer, SourceRenderer } from './renderer.js';
import type { TextPage } from './types.js';

const HOST = '127.0.0.1';

const RETRIEVAL_SYSTEM_SUFFIX =
  '\n\nAnswer only from the document excerpts provided below. ' +
  'Each excerpt is labelled with its document and page numbers. ' +
  'Cite the page you used inline. If the excerpts do not contain the answer, say so plainly instead of guessing.';

/**
 * Loopback-only HTTP surface over the same pipeline the CLI drives.
 *
 * There is deliberately no authentication here: the .NET `jwt` cookie is not
 * validated by this process, so it must never listen on a public interface.
 * The Angular dev server reaches it through the /api/local proxy rule.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.ollama.chatModel) {
    throw new Error('OLLAMA_CHAT_MODEL must be set to serve /api/local/chat');
  }
  const logger = new Logger(config.logLevel);

  const ragStore = new PostgresRagStore(config.postgresConnectionString, {
    writeUserId: config.ragWriteUserId,
    embeddingModel: config.ollama.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
  });
  const ollama = new OllamaClient({
    baseUrl: config.ollama.baseUrl,
    ocrModel: config.ollama.ocrModel,
    embeddingModel: config.ollama.embeddingModel,
    dimensions: config.embeddingDimensions,
    chatModel: config.ollama.chatModel,
  });
  // No archiveReader: every route here supplies its own bytes, so this process
  // never opens a SQL Server connection and does not need one configured.
  const pipeline = new IngestionPipeline({
    ragStore,
    renderer: new SourceRenderer(
      new ImagePageRenderer(),
      new PopplerPdfRenderer({
        executable: config.pdfToPpmPath,
        maxPages: config.limits.maxPages,
        timeoutMs: config.limits.pdfRenderTimeoutMs,
      }),
    ),
    ollama,
    mappingVersion: config.archiveMapping.version,
    embeddingDimensions: config.embeddingDimensions,
    chunkMaxCharacters: config.limits.chunkMaxChars,
    chunkOverlapCharacters: config.limits.chunkOverlapChars,
    maxAttempts: config.retries.maxAttempts,
    retryBaseMs: config.retries.baseMs,
    retryMaxMs: config.retries.maxMs,
    logger,
  });

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const safe = sanitizeError(error);
      logger.error('request_failed', { url: request.url, ...safe });
      sendJson(response, statusFor(safe.code, safe.retryable), { error: safe.message, code: safe.code });
    });
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${HOST}`);
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /api/local/health') return sendJson(response, 200, await health());
    if (route === 'POST /api/local/ingest') return sendJson(response, 200, await ingest(url, request));
    if (route === 'POST /api/local/chat') return sendJson(response, 200, await chat(request));
    return sendJson(response, 404, { error: 'Unknown route', code: 'unknown' });
  }

  // Scope rows are created on demand now, so there is no per-record readiness to
  // report and this takes no parameters.
  async function health(): Promise<Record<string, unknown>> {
    const [postgres, models] = await Promise.all([
      ragStore.preflight().then(() => true).catch(() => false),
      listOllamaModels().catch(() => null),
    ]);
    const required = [config.ollama.ocrModel, config.ollama.embeddingModel, config.ollama.chatModel!];
    const missingModels = models ? required.filter((name) => !models.some((m) => m === name || m.startsWith(`${name}:`))) : required;

    return {
      ok: postgres && models !== null && missingModels.length === 0,
      postgres,
      ollama: models !== null,
      missingModels,
    };
  }

  async function ingest(url: URL, request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const archiveId = requirePositiveInteger(url.searchParams.get('archiveId'), 'archiveId');
    const objectType = (url.searchParams.get('objectType') ?? '').trim();
    const objectId = requirePositiveInteger(url.searchParams.get('objectId'), 'objectId');
    const label = (url.searchParams.get('label') ?? '').trim();
    const fileName = (url.searchParams.get('fileName') ?? `archive-${archiveId}`).slice(0, 260);
    const bytes = await readBody(request, config.limits.maxSourceBytes);
    if (!bytes.length) throw new ServiceError('Request body is empty', 'unsupported_file', false);

    // Entity ids are unique only within their type, so the scope row is resolved
    // to a surrogate rag.claim.id rather than using objectId directly.
    const scopeId = await ragStore.resolveScope(objectType, objectId, label);

    const result = await pipeline.ingestSource({
      archiveId,
      sourceClaimId: scopeId,
      fileName,
      mimeType: request.headers['content-type'] ?? 'application/octet-stream',
      bytes,
    });

    if (result.outcome === 'failed' || result.outcome === 'retry_wait') {
      // Surface the pipeline's own reason. Inventing a code here once turned a
      // missing rag.claim row into a misleading "ollama" error.
      const cause = result.error;
      throw new ServiceError(
        cause ? `Ingestion failed for archive ${archiveId}: ${cause.message}` : `Ingestion ${result.outcome} for archive ${archiveId}`,
        cause?.code ?? 'unknown',
        result.outcome === 'retry_wait',
      );
    }

    // A skip means these exact bytes are already indexed, so the stored OCR text
    // is read back rather than paying for the vision model a second time.
    const pages = result.pages ?? (result.documentId ? await ragStore.getDocumentPages(result.documentId) : []);
    return {
      documentId: result.documentId ?? null,
      ragDocumentId: result.ragDocumentId ?? null,
      scopeId,
      reused: result.outcome === 'skipped',
      modelid: config.ollama.ocrModel,
      content: pages.map((page) => `# Page ${page.pageIndex}\n\n${page.text}`).join('\n\n'),
      pages: pages.map((page) => ({ pageNumber: page.pageIndex, text: page.text })),
      pageCount: pages.length,
      elapsedTimeMs: Date.now() - startedAt,
    };
  }

  async function chat(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const body = parseJson(await readBody(request, 1_048_576));
    const prompt = typeof body['prompt'] === 'string' ? body['prompt'].trim() : '';
    if (!prompt) throw new ServiceError('prompt is required', 'configuration', false);
    const documentIds = Array.isArray(body['documentIds'])
      ? body['documentIds'].map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
      : [];
    if (!documentIds.length) throw new ServiceError('documentIds must contain at least one ingested document', 'configuration', false);
    const topK = Number.isSafeInteger(Number(body['topK'])) && Number(body['topK']) > 0 ? Number(body['topK']) : config.ragTopK;

    const [queryEmbedding] = await ollama.embed([prompt]);
    if (!queryEmbedding) throw new ServiceError('Could not embed the prompt', 'ollama', true);
    const hits = await ragStore.searchChunks(queryEmbedding, documentIds, topK);

    if (!hits.length) {
      return {
        reply: 'No indexed content matched this question. Re-run OCR for these documents in local mode, then try again.',
        citations: [],
        elapsedTimeMs: Date.now() - startedAt,
      };
    }

    const reply = await ollama.chat(prompt + RETRIEVAL_SYSTEM_SUFFIX, hits.map(excerpt).join('\n\n---\n\n'));
    logger.info('local_chat_completed', { documentIds: documentIds.length, hits: hits.length, elapsedMs: Date.now() - startedAt });
    return {
      reply,
      citations: hits.map((hit) => ({
        documentId: hit.documentId,
        pageStart: hit.pageStart,
        pageEnd: hit.pageEnd,
        distance: Number(hit.distance.toFixed(4)),
      })),
      elapsedTimeMs: Date.now() - startedAt,
    };
  }

  async function listOllamaModels(): Promise<string[]> {
    const response = await fetch(new URL('/api/tags', config.ollama.baseUrl), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new ServiceError(`Ollama returned HTTP ${response.status}`, 'ollama', true);
    const body = (await response.json()) as { models?: Array<{ name?: unknown }> };
    return (body.models ?? []).map((model) => String(model.name ?? '')).filter(Boolean);
  }

  await new Promise<void>((resolve) => server.listen(config.localApiPort, HOST, resolve));
  logger.info('local_api_listening', { host: HOST, port: config.localApiPort });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      void ragStore.close().catch(() => undefined).then(() => process.exit(0));
    });
  }
}

function excerpt(hit: ChunkHit): string {
  const pages = hit.pageStart === hit.pageEnd ? `page ${hit.pageStart}` : `pages ${hit.pageStart}-${hit.pageEnd}`;
  return `[document ${hit.documentId} · ${pages}]\n${hit.content}`;
}

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        request.destroy();
        reject(new ServiceError('Request body exceeds the configured size limit', 'source_limit', false));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', (error) => reject(new ServiceError(`Request body failed: ${error.message}`, 'unknown', false)));
  });
}

function parseJson(body: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ServiceError('Request body must be a JSON object', 'configuration', false);
  }
}

function requirePositiveInteger(value: string | null, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ServiceError(`${name} must be a positive integer`, 'configuration', false);
  }
  return number;
}

function statusFor(code: ErrorCode, retryable: boolean): number {
  if (retryable) return 503;
  if (code === 'configuration' || code === 'unsupported_file') return 400;
  if (code === 'source_not_found') return 404;
  if (code === 'source_limit') return 413;
  return 500;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'fatal', ...sanitizeError(error) }));
  process.exitCode = 1;
});
