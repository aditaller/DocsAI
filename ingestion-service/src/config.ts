import { z } from 'zod';

import { OCR_ENGINE_IDS, type OcrEngineId } from './types.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const identifierSchema = z.string().regex(IDENTIFIER, 'must be a simple SQL identifier');
const mappingSchema = z
  .object({
    version: z.string().min(1).max(100),
    schema: identifierSchema,
    relation: identifierSchema,
    idColumn: identifierSchema,
    claimIdColumn: identifierSchema,
    fileNameColumn: identifierSchema,
    mimeTypeColumn: identifierSchema.nullable(),
    contentColumn: identifierSchema.nullable(),
    fullPathColumn: identifierSchema.nullable(),
    modifiedAtColumn: identifierSchema.nullable(),
  })
  .superRefine((mapping, context) => {
    if (!mapping.contentColumn && !mapping.fullPathColumn) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'configure contentColumn or fullPathColumn',
      });
    }
  });

const environmentSchema = z.object({
  // Required by the batch CLI, which reads source rows from SQL Server. The HTTP
  // server never opens that connection — its callers supply the bytes — so it is
  // optional here and enforced by cli.ts instead.
  SQLSERVER_CONNECTION_STRING: z.string().min(1).optional(),
  POSTGRES_CONNECTION_STRING: z.string().min(1),
  ARCHIVE_MAPPING_JSON: z.string().min(2),
  RAG_WRITE_USER_ID: z.coerce.number().int().positive(),
  ARCHIVE_FILE_ROOT: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_OCR_MODEL: z.string().min(1),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1),
  // Only the HTTP server completes text; the batch CLI runs without it.
  OLLAMA_CHAT_MODEL: z.string().min(1).optional(),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(65_535),
  // Retrieval prompts carry several chunks and overrun Ollama's 4096 default.
  // OCR needs the headroom too: a reasoning vision model burns the default on
  // thinking and returns an empty transcription.
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2_048).max(1_048_576).default(16_384),
  // How long Ollama holds a model in VRAM after a call. Chat and embedding run
  // back to back on every question, so an expiry short enough to unload between
  // them makes each turn pay a multi-second reload. Ollama's own duration
  // strings ('1h', '30m', '-1' for forever).
  OLLAMA_KEEP_ALIVE: z.string().min(1).default('1h'),
  // Which engine reads the pages. The HTTP server lets a request override this
  // per document; the batch CLI has no such caller and runs whatever is set here.
  LOCAL_OCR_ENGINE: z.enum(OCR_ENGINE_IDS).default('tesseract-auto'),
  // Azure Document Intelligence's Layout model, run as a local container. It is
  // held to the same loopback rule as Ollama: the container reads the document
  // on this host and only reports page counts to Azure for billing, so the
  // document itself must never be sent across a network to reach it.
  AZURE_LAYOUT_URL: z.string().url().default('http://127.0.0.1:5000'),
  TESSERACT_CONTAINER: z.string().min(1).default('tesseract-ocr'),
  // Order matters: the first language is the primary one. `heb+eng` reads Hebrew
  // documents that carry Latin names, numbers and stamps — dropping `eng` there
  // turns every date and amount into noise.
  TESSERACT_LANGS_HEB: z.string().min(1).default('heb+eng'),
  // An English document is read better without `heb` loaded at all.
  TESSERACT_LANGS_ENG: z.string().min(1).default('eng'),
  LOCAL_API_PORT: z.coerce.number().int().min(1_024).max(65_535).default(11_500),
  RAG_TOP_K: z.coerce.number().int().min(1).max(100).default(8),
  PDFTOPPM_PATH: z.string().min(1).default('pdftoppm'),
  // poppler's own default. Tesseract wants 300 for Hebrew; the vision model pays
  // for the extra pixels in image tokens, so this is left where it was.
  // Script detection reads the same render, and a 150dpi Hebrew scan is also
  // where OSD is likeliest to answer below MIN_SCRIPT_CONFIDENCE.
  PDF_RENDER_DPI: z.coerce.number().int().min(72).max(600).default(150),
  MAX_SOURCE_BYTES: z.coerce.number().int().positive().max(1_073_741_824).default(52_428_800),
  MAX_PAGES: z.coerce.number().int().positive().max(10_000).default(100),
  PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(120_000),
  CHUNK_MAX_CHARS: z.coerce.number().int().min(100).max(20_000).default(1_800),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).max(10_000).default(200),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(4),
  RETRY_BASE_MS: z.coerce.number().int().min(10).max(300_000).default(1_000),
  RETRY_MAX_MS: z.coerce.number().int().min(10).max(3_600_000).default(60_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ArchiveMapping = z.infer<typeof mappingSchema>;
export interface AppConfig {
  sqlServerConnectionString?: string;
  postgresConnectionString: string;
  archiveMapping: ArchiveMapping;
  ragWriteUserId: number;
  archiveFileRoot?: string;
  ollama: {
    baseUrl: URL;
    ocrModel: string;
    embeddingModel: string;
    chatModel?: string;
    numContext: number;
    keepAlive: string;
  };
  tesseract: {
    container: string;
    /** Language spec per tesseract engine id, keyed by the id the caller asks for. */
    langs: Record<'tesseract-heb' | 'tesseract-eng', string>;
  };
  azureLayout: {
    baseUrl: URL;
  };
  localOcrEngine: OcrEngineId;
  embeddingDimensions: number;
  localApiPort: number;
  ragTopK: number;
  pdfToPpmPath: string;
  limits: {
    maxSourceBytes: number;
    maxPages: number;
    pdfRenderTimeoutMs: number;
    pdfRenderDpi: number;
    chunkMaxChars: number;
    chunkOverlapChars: number;
  };
  retries: {
    maxAttempts: number;
    baseMs: number;
    maxMs: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function parseMapping(raw: string): ArchiveMapping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ARCHIVE_MAPPING_JSON must be valid JSON');
  }
  return mappingSchema.parse(parsed);
}

function assertLoopback(url: URL, variable: string): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${variable} must use http or https`);
  }
  // A hostname such as `localhost` can be remapped through host/DNS
  // configuration. Use literal loopback addresses so this safety boundary does
  // not depend on name resolution.
  const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]']);
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(`${variable} must resolve to a loopback host`);
  }
}

/**
 * Zod's raw issue dump is unreadable on a terminal, and the most common failure
 * by far is simply having no .env yet. Name the variables and say what to do.
 */
function describeEnvironmentIssues(error: z.ZodError): string {
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const issue of error.issues) {
    const name = issue.path.join('.');
    if (issue.code === 'invalid_type' && issue.received === 'undefined') missing.push(name);
    else invalid.push(`${name} (${issue.message})`);
  }
  const parts: string[] = [];
  if (missing.length) parts.push(`missing ${missing.join(', ')}`);
  if (invalid.length) parts.push(`invalid ${invalid.join(', ')}`);
  return `Configuration error: ${parts.join('; ')}. Copy .env.example to .env and fill in the values.`;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) throw new Error(describeEnvironmentIssues(parsed.error));
  const env = parsed.data;
  const mapping = parseMapping(env.ARCHIVE_MAPPING_JSON);
  if (!mapping.contentColumn && !env.ARCHIVE_FILE_ROOT) {
    throw new Error('ARCHIVE_FILE_ROOT is required when contentColumn is not configured');
  }
  if (env.CHUNK_OVERLAP_CHARS >= env.CHUNK_MAX_CHARS) {
    throw new Error('CHUNK_OVERLAP_CHARS must be smaller than CHUNK_MAX_CHARS');
  }

  const baseUrl = new URL(env.OLLAMA_BASE_URL);
  assertLoopback(baseUrl, 'OLLAMA_BASE_URL');
  const azureLayoutUrl = new URL(env.AZURE_LAYOUT_URL);
  assertLoopback(azureLayoutUrl, 'AZURE_LAYOUT_URL');
  return {
    ...(env.SQLSERVER_CONNECTION_STRING ? { sqlServerConnectionString: env.SQLSERVER_CONNECTION_STRING } : {}),
    postgresConnectionString: env.POSTGRES_CONNECTION_STRING,
    archiveMapping: mapping,
    ragWriteUserId: env.RAG_WRITE_USER_ID,
    ...(env.ARCHIVE_FILE_ROOT ? { archiveFileRoot: env.ARCHIVE_FILE_ROOT } : {}),
    ollama: {
      baseUrl,
      ocrModel: env.OLLAMA_OCR_MODEL,
      embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
      ...(env.OLLAMA_CHAT_MODEL ? { chatModel: env.OLLAMA_CHAT_MODEL } : {}),
      numContext: env.OLLAMA_NUM_CTX,
      keepAlive: env.OLLAMA_KEEP_ALIVE,
    },
    tesseract: {
      container: env.TESSERACT_CONTAINER,
      langs: { 'tesseract-heb': env.TESSERACT_LANGS_HEB, 'tesseract-eng': env.TESSERACT_LANGS_ENG },
    },
    azureLayout: { baseUrl: azureLayoutUrl },
    localOcrEngine: env.LOCAL_OCR_ENGINE,
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
    localApiPort: env.LOCAL_API_PORT,
    ragTopK: env.RAG_TOP_K,
    pdfToPpmPath: env.PDFTOPPM_PATH,
    limits: {
      maxSourceBytes: env.MAX_SOURCE_BYTES,
      maxPages: env.MAX_PAGES,
      pdfRenderTimeoutMs: env.PDF_RENDER_TIMEOUT_MS,
      pdfRenderDpi: env.PDF_RENDER_DPI,
      chunkMaxChars: env.CHUNK_MAX_CHARS,
      chunkOverlapChars: env.CHUNK_OVERLAP_CHARS,
    },
    retries: {
      maxAttempts: env.MAX_ATTEMPTS,
      baseMs: env.RETRY_BASE_MS,
      maxMs: env.RETRY_MAX_MS,
    },
    logLevel: env.LOG_LEVEL,
  };
}

export function quoteSqlServerIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`Unsafe SQL Server identifier: ${identifier}`);
  }
  return `[${identifier}]`;
}

export function quoteSqlServerRelation(schema: string, relation: string): string {
  return `${quoteSqlServerIdentifier(schema)}.${quoteSqlServerIdentifier(relation)}`;
}

export function quotePostgresIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function quotePostgresRelation(schema: string, relation: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(relation)}`;
}
