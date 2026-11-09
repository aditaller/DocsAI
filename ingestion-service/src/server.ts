import 'dotenv/config';

import http from 'node:http';

import { loadConfig } from './config.js';
import { sanitizeError, ServiceError, type ErrorCode } from './errors.js';
import { Logger } from './logger.js';
import { averageConfidence, detectLanguage, OllamaClient, systemPromptFor, toPercent } from './ollama.js';
import { IngestionPipeline } from './pipeline.js';
import { PostgresRagStore, type ChunkHit } from './rag-store.js';
import { ImagePageRenderer, PopplerPdfRenderer, SourceRenderer } from './renderer.js';
import { AzureLayoutClient } from './azure-layout.js';
import { createTesseractRecognizer, detectScript, TesseractClient } from './tesseract.js';
import { OCR_ENGINE_IDS, type OcrEngineChoice, type OcrEngineId, type TextPage } from './types.js';

const HOST = '127.0.0.1';

/** Share of the context window left for the answer rather than the documents. */
const ANSWER_HEADROOM = 0.7;
/**
 * Characters per token for this corpus, measured rather than assumed. Ollama
 * exposes no tokenizer endpoint, so this comes from `prompt_eval_count` on real
 * gpt-oss:20b calls, less the 63-token prompt overhead:
 *
 *   Hebrew                 1800 chars / 600 tokens = 3.00
 *   English                1890 chars / 390 tokens = 4.85
 *   pdftotext -layout pads 2400 chars / 389 tokens = 6.17
 *
 * 3.00 is the worst observed case rather than a typical one: Latin text and the
 * column padding both tokenize far better. Under-reserving here is what causes a
 * silent truncation instead of a clear refusal, so the worst case is what the
 * budget is built on. `local_chat_completed` logs the real count against this
 * estimate on every call — re-measure from those logs rather than guessing again.
 */
const CHARS_PER_TOKEN = 3.0;

interface ChatContext {
  context: string;
  citations: Array<{ documentId: number; pageStart: number; pageEnd: number; distance?: number }>;
  /**
   * Set when a full-document selection exceeded the context budget. Reported
   * rather than thrown, so the caller can fall back to retrieval instead of
   * failing  and can tell the user which of the two it got.
   */
  overBudget?: { chars: number; budget: number };
  /** Set when there is nothing to answer from; carries the message to show. */
  empty: string | null;
}


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
    numContext: config.ollama.numContext,
    keepAlive: config.ollama.keepAlive,
    onTruncated: (pageIndex) => logger.warn('ocr_page_truncated', { pageIndex }),
    // Logged from the client rather than carried back to the request: the value
    // arrives mid-stream, and logging it where it lands keeps two concurrent
    // chats from attributing each other's counts.
    onPromptTokens: (tokens) =>
      logger.info('chat_prompt_tokens', { tokens, contextLimit: config.ollama.numContext, allowance: Math.floor(config.ollama.numContext * ANSWER_HEADROOM) }),
  });
  // The same client against a different vision model, so the two can be run on
  // one scan from the engine picker. It only ever recognizes pages; embedding and
  // chat stay on `ollama` above, and the prompt follows from the model name.
  const deepseekOcr = new OllamaClient({
    baseUrl: config.ollama.baseUrl,
    ocrModel: config.ollama.deepseekOcrModel,
    embeddingModel: config.ollama.embeddingModel,
    dimensions: config.embeddingDimensions,
    numContext: config.ollama.numContext,
    keepAlive: config.ollama.keepAlive,
    onTruncated: (pageIndex) => logger.warn('ocr_page_truncated', { pageIndex }),
  });
  // Health only: proves the container answers. The engines below build their own,
  // because tesseract-auto remembers the script it read and two concurrent
  // uploads must not share that memory.
  const tesseractHeb = new TesseractClient({ container: config.tesseract.container, langs: config.tesseract.langs['tesseract-heb'] });
  // Every ingest names its engine; the request may override the configured one
  // per document, which is how they are compared on the same scan.
  const engineFor = (id: OcrEngineId): OcrEngineChoice => {
    if (id === 'ollama') return { id, recognizer: ollama };
    if (id === 'deepseek-ocr') return { id, recognizer: deepseekOcr };
    if (id === 'azure-layout') return { id, recognizer: new AzureLayoutClient({ baseUrl: config.azureLayout.baseUrl }) };
    return { id, recognizer: createTesseractRecognizer(id, config.tesseract) };
  };
  // Held in a local rather than inlined, so health() can probe the binary.
  const pdfRenderer = new PopplerPdfRenderer({
    executable: config.pdfToPpmPath,
    maxPages: config.limits.maxPages,
    timeoutMs: config.limits.pdfRenderTimeoutMs,
    dpi: config.limits.pdfRenderDpi,
  });
  // No archiveReader: every route here supplies its own bytes, so this process
  // never opens a SQL Server connection and does not need one configured.
  const pipeline = new IngestionPipeline({
    ragStore,
    renderer: new SourceRenderer(new ImagePageRenderer(), pdfRenderer),
    ollama,
    ocr: engineFor(config.localOcrEngine),
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
    if (route === 'POST /api/local/chat') return chat(request, response);
    return sendJson(response, 404, { error: 'Unknown route', code: 'unknown' });
  }

  // Scope rows are created on demand now, so there is no per-record readiness to
  // report and this takes no parameters.
  async function health(): Promise<Record<string, unknown>> {
    const [postgres, models, tesseractVersion, pdftoppm, azureLayout] = await Promise.all([
      ragStore.preflight().then(() => true).catch(() => false),
      listOllamaModels().catch(() => null),
      // Either client proves the container answers; they differ only in languages.
      tesseractHeb.version().catch(() => null),
      pdfRenderer.version().then(() => true).catch(() => false),
      new AzureLayoutClient({ baseUrl: config.azureLayout.baseUrl }).version().then(() => true).catch(() => false),
    ]);
    const required = [config.ollama.ocrModel, config.ollama.embeddingModel, config.ollama.chatModel!];
    const missingModels = models ? required.filter((name) => !models.some((m) => m === name || m.startsWith(`${name}:`))) : required;

    return {
      // Ollama still gates `ok`: it embeds and answers on both OCR paths, so the
      // local mode is unusable without it whatever the container is doing.
      ok: postgres && models !== null && missingModels.length === 0,
      postgres,
      ollama: models !== null,
      missingModels,
      tesseract: tesseractVersion !== null,
      // Out of the `ok` gate for the same reason as tesseract: images still
      // ingest without poppler, only PDFs need it.
      pdftoppm,
      // Also out of the gate: it is the only engine that reads checkbox answers,
      // but every other kind of document ingests without it. The UI uses this to
      // decide whether to offer `azure-layout` at all — the container is billed
      // per page and is not expected to be running unless it is wanted.
      azureLayout,
      engine: config.localOcrEngine,
      // The two vision engines are named by whatever model is configured, so the
      // picker can label them for real instead of saying "Ollama Vision" and
      // leaving the operator to guess which model just read the page.
      ocrModel: config.ollama.ocrModel,
      deepseekOcrModel: config.ollama.deepseekOcrModel,
    };
  }

  async function ingest(url: URL, request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const archiveId = requirePositiveInteger(url.searchParams.get('archiveId'), 'archiveId');
    const objectType = (url.searchParams.get('objectType') ?? '').trim();
    const objectId = requirePositiveInteger(url.searchParams.get('objectId'), 'objectId');
    const label = (url.searchParams.get('label') ?? '').trim();
    const fileName = (url.searchParams.get('fileName') ?? `archive-${archiveId}`).slice(0, 260);
    const engine = requireEngine(url.searchParams.get('engine'), config.localOcrEngine);
    const bytes = await readBody(request, config.limits.maxSourceBytes);
    if (!bytes.length) throw new ServiceError('Request body is empty', 'unsupported_file', false);

    // Entity ids are unique only within their type, so the scope row is resolved
    // to a surrogate rag.claim.id rather than using objectId directly.
    const scopeId = await ragStore.resolveScope(objectType, objectId, label);

    // Held typed rather than reached through engineFor, so the language set it
    // settles on is readable when the response is built.
    const tesseract =
      engine === 'ollama' || engine === 'deepseek-ocr' || engine === 'azure-layout'
        ? null
        : createTesseractRecognizer(engine, config.tesseract);
    const ocr: OcrEngineChoice = tesseract ? { id: engine, recognizer: tesseract } : engineFor(engine);
    const result = await pipeline.ingestSource({
      archiveId,
      sourceClaimId: scopeId,
      fileName,
      mimeType: request.headers['content-type'] ?? 'application/octet-stream',
      bytes,
    }, {
      // Someone re-submitting a document through the UI is asking for a retry;
      // otherwise one terminal failure would lock that archive id out for good.
      retryTerminal: true,
      ocr,
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
    // What the work actually cost. On a skip that is the stored run duration, not
    // the moments this request spent discovering there was nothing to do.
    const totalMs = result.totalDurationMs ?? (result.documentId ? await ragStore.getDocumentDurationMs(result.documentId) : null);
    return {
      documentId: result.documentId ?? null,
      ragDocumentId: result.ragDocumentId ?? null,
      scopeId,
      reused: result.outcome === 'skipped',
      engine,
      // The language set that actually ran, which under tesseract-auto is only
      // known once page 1 has been read — and not at all on a reuse that skipped OCR.
      modelid: tesseract
        ? `tesseract:${tesseract.langs ?? 'osd'}`
        : engine === 'azure-layout'
          ? 'azure:prebuilt-layout'
          : engine === 'deepseek-ocr'
            ? config.ollama.deepseekOcrModel
            : config.ollama.ocrModel,
      // Page 1 speaks for the document; a mixed-language scan is not worth a per-page field yet.
      // Only `ollama` is asked for a `Language:` line. Tesseract reports no language
      // of its own, and DeepSeek-OCR's prompt is fixed and cannot ask for one, so
      // both are read by script off the text instead.
      language: engine === 'ollama' ? detectLanguage(pages[0]?.text ?? '') : detectScript(pages[0]?.text ?? ''),
      // Same 0–100 scale Azure Document Intelligence reports. ponytail: not persisted,
      // so a reused (already-indexed) document reports null; add a documentpage
      // column if the score has to survive the re-submit.
      confidence: averageConfidence(pages),
      pages: pages.map((page) => ({
        pageNumber: page.pageIndex,
        text: page.text,
        confidence: toPercent(page.confidence),
      })),
      content: pages.map((page) => `# Page ${page.pageIndex}\n\n${page.text}`).join('\n\n'),
      pageCount: pages.length,
      totalMs,
      elapsedTimeMs: Date.now() - startedAt,
    };
  }

  /**
   * Two ways to put documents in front of the model, chosen by the caller:
   *
   * - `full: true` sends every OCR page of every named document, in the order
   *   they were selected. This is what "Analyze with AI" uses, so that the local
   *   answer is drawn from the same evidence the cloud path sends. No embedding
   *   call, no ranking, nothing silently dropped.
   * - `full: false` (the default) embeds the question and retrieves the nearest
   *   chunks. This is what the chat drawer uses, where a follow-up question is
   *   narrow and the whole archive need not be re-read for it.
   *
   * The reply streams either way.
   */
  async function chat(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const body = parseJson(await readBody(request, 1_048_576));
    const prompt = typeof body['prompt'] === 'string' ? body['prompt'].trim() : '';
    if (!prompt) throw new ServiceError('prompt is required', 'configuration', false);
    const documentIds = Array.isArray(body['documentIds'])
      ? body['documentIds'].map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
      : [];
    if (!documentIds.length) throw new ServiceError('documentIds must contain at least one ingested document', 'configuration', false);
    const full = body['full'] === true;
    const topK = Number.isSafeInteger(Number(body['topK'])) && Number(body['topK']) > 0 ? Number(body['topK']) : config.ragTopK;

    // Full mode falls back to retrieval when the selection cannot fit, rather
    // than refusing: a 94-page document has no whole-document answer at this
    // context size, and the nearest chunks beat a dead end. The fallback is
    // reported to the caller, not hidden  an answer drawn from excerpts must
    // never be presented as one drawn from every page.
    let selected = full ? await fullDocumentContext(documentIds) : await retrievedContext(prompt, documentIds, topK);
    let mode: 'full' | 'retrieval' = full ? 'full' : 'retrieval';
    let fellBack: { chars: number; budget: number } | null = null;
    if (selected.overBudget) {
      fellBack = selected.overBudget;
      mode = 'retrieval';
      // Fill the budget rather than using the drawer's topK: the caller asked to
      // read the whole document, so give the model as much of it as will fit.
      const fillTopK = Math.max(topK, Math.floor(selected.overBudget.budget / config.limits.chunkMaxChars));
      selected = await retrievedContext(prompt, documentIds, fillTopK);
    }
    const { context, citations, empty } = selected;

    if (empty) {
      // Nothing to answer from. Still an SSE response, so the client has one
      // code path rather than two.
      return sendEventStream(response, (send) => {
        send({ token: empty });
        send({ done: true, citations: [], elapsedTimeMs: Date.now() - startedAt });
        return Promise.resolve();
      });
    }

    await sendEventStream(response, async (send) => {
      await ollama.chat(systemPromptFor(prompt), context, (token, thinking) =>
        send(thinking ? { thinking: token } : { token }),
      );
      send({
        done: true,
        citations,
        mode,
        ...(fellBack ? { fellBack } : {}),
        elapsedTimeMs: Date.now() - startedAt,
      });
      logger.info('local_chat_completed', {
        documentIds: documentIds.length,
        mode,
        requested: full ? 'full' : 'retrieval',
        sources: citations.length,
        // Paired with chat_prompt_tokens above it: the estimate this budget was
        // built on, next to what the model actually read.
        contextChars: context.length,
        estimatedTokens: Math.ceil(context.length / CHARS_PER_TOKEN),
        elapsedMs: Date.now() - startedAt,
      });
    });
  }

  /** Every page of every selected document, refused up front when it cannot fit. */
  async function fullDocumentContext(documentIds: number[]): Promise<ChatContext> {
    const documents = await Promise.all(documentIds.map(async (id) => ({ id, pages: await ragStore.getDocumentPages(id) })));
    const withPages = documents.filter((document) => document.pages.length > 0);
    if (!withPages.length) {
      return { context: '', citations: [], empty: 'None of these documents have indexed OCR text. Re-run OCR in local mode, then try again.' };
    }

    const context = withPages
      .map(({ id, pages }) => pages.map((page) => `[document ${id} · page ${page.pageIndex}]\n${page.text}`).join('\n\n'))
      .join('\n\n---\n\n');

    // Budgeted in characters, not words. The stored `tokencount` is a word count,
    // and garbled or Hebrew OCR runs 2-3 tokens per word — budgeting on it would
    // wave through a selection that Ollama then silently truncates, which is the
    // failure this mode exists to remove.
    const budget = Math.floor(config.ollama.numContext * ANSWER_HEADROOM * CHARS_PER_TOKEN);
    if (context.length > budget) {
      // Reported, not thrown: the caller retries this as a retrieval query. A
      // document this size has no whole-document answer at this context length,
      // and raising OLLAMA_NUM_CTX far enough costs VRAM the GPU does not have.
      return { context: '', citations: [], empty: null, overBudget: { chars: context.length, budget } };
    }

    return {
      context,
      citations: withPages.map(({ id, pages }) => ({
        documentId: id,
        pageStart: pages[0]!.pageIndex,
        pageEnd: pages[pages.length - 1]!.pageIndex,
      })),
      empty: null,
    };
  }

  /** The nearest chunks to the question, for narrow follow-ups. */
  async function retrievedContext(prompt: string, documentIds: number[], topK: number): Promise<ChatContext> {
    const [queryEmbedding] = await ollama.embed([prompt]);
    if (!queryEmbedding) throw new ServiceError('Could not embed the prompt', 'ollama', true);
    const hits = await ragStore.searchChunks(queryEmbedding, documentIds, topK);
    if (!hits.length) {
      return { context: '', citations: [], empty: 'No indexed content matched this question. Re-run OCR for these documents in local mode, then try again.' };
    }
    return {
      context: hits.map(excerpt).join('\n\n---\n\n'),
      citations: hits.map((hit) => ({
        documentId: hit.documentId,
        pageStart: hit.pageStart,
        pageEnd: hit.pageEnd,
        distance: Number(hit.distance.toFixed(4)),
      })),
      empty: null,
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

/**
 * Streams Server-Sent Events. `write` is called with each frame; the browser
 * reads `{token}` fragments followed by one `{done, citations, elapsedTimeMs}`.
 *
 * Headers go out before the model is called, so a failure partway through cannot
 * be turned into an HTTP status any more — it is sent as a final `{error}` frame
 * instead, and the client keeps the partial answer and says it was cut short.
 * Silently ending the stream would render a half answer as if it were complete.
 */
async function sendEventStream(
  response: http.ServerResponse,
  produce: (send: (frame: Record<string, unknown>) => void) => Promise<void>,
): Promise<void> {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const send = (frame: Record<string, unknown>): void => {
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  };
  try {
    await produce(send);
  } catch (error) {
    const safe = sanitizeError(error);
    send({ error: safe.message, code: safe.code });
  } finally {
    response.end();
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

function requireEngine(value: string | null, fallback: OcrEngineId): OcrEngineId {
  if (value === null || value === '') return fallback;
  const engine = OCR_ENGINE_IDS.find((candidate) => candidate === value);
  if (!engine) {
    throw new ServiceError(`engine must be one of ${OCR_ENGINE_IDS.join(', ')}`, 'configuration', false);
  }
  return engine;
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
