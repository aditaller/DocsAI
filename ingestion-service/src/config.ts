import { z } from 'zod';

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
  // Ollama defaults to 4096 whatever the model supports, which truncates dense
  // pages and large retrieval prompts.
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2_048).max(1_048_576).default(16_384),
  LOCAL_API_PORT: z.coerce.number().int().min(1_024).max(65_535).default(11_500),
  RAG_TOP_K: z.coerce.number().int().min(1).max(100).default(8),
  PDFTOPPM_PATH: z.string().min(1).default('pdftoppm'),
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
  };
  embeddingDimensions: number;
  localApiPort: number;
  ragTopK: number;
  pdfToPpmPath: string;
  limits: {
    maxSourceBytes: number;
    maxPages: number;
    pdfRenderTimeoutMs: number;
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

function assertLocalOllama(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OLLAMA_BASE_URL must use http or https');
  }
  // A hostname such as `localhost` can be remapped through host/DNS
  // configuration. Use literal loopback addresses so this safety boundary does
  // not depend on name resolution.
  const loopbackHosts = new Set(['127.0.0.1', '::1', '[::1]']);
  if (!loopbackHosts.has(url.hostname)) {
    throw new Error('OLLAMA_BASE_URL must resolve to a loopback host');
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
  assertLocalOllama(baseUrl);
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
    },
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
    localApiPort: env.LOCAL_API_PORT,
    ragTopK: env.RAG_TOP_K,
    pdfToPpmPath: env.PDFTOPPM_PATH,
    limits: {
      maxSourceBytes: env.MAX_SOURCE_BYTES,
      maxPages: env.MAX_PAGES,
      pdfRenderTimeoutMs: env.PDF_RENDER_TIMEOUT_MS,
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
