import 'dotenv/config';

import { SqlServerArchiveReader } from './archive-reader.js';
import { loadConfig } from './config.js';
import { sanitizeError } from './errors.js';
import { Logger } from './logger.js';
import { OllamaClient } from './ollama.js';
import { IngestionPipeline } from './pipeline.js';
import { PostgresRagStore } from './rag-store.js';
import { ImagePageRenderer, PopplerPdfRenderer, SourceRenderer } from './renderer.js';

interface IngestArguments {
  archiveId?: number;
  afterId: number;
  limit: number;
  dryRun: boolean;
}

async function main(): Promise<void> {
  const [command, ...argumentsList] = process.argv.slice(2);
  if (command !== 'preflight' && command !== 'ingest') usage();
  const config = loadConfig();
  if (!config.sqlServerConnectionString) {
    throw new Error('SQLSERVER_CONNECTION_STRING is required: the batch CLI reads its source rows from SQL Server');
  }
  const logger = new Logger(config.logLevel);
  const archiveReader = new SqlServerArchiveReader({
    connectionString: config.sqlServerConnectionString,
    mapping: config.archiveMapping,
    maxSourceBytes: config.limits.maxSourceBytes,
    ...(config.archiveFileRoot ? { archiveFileRoot: config.archiveFileRoot } : {}),
  });
  const ragStore = new PostgresRagStore(config.postgresConnectionString, {
    writeUserId: config.ragWriteUserId,
    embeddingModel: config.ollama.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
  });
  const pipeline = new IngestionPipeline({
    archiveReader,
    ragStore,
    renderer: new SourceRenderer(
      new ImagePageRenderer(),
      new PopplerPdfRenderer({
        executable: config.pdfToPpmPath,
        maxPages: config.limits.maxPages,
        timeoutMs: config.limits.pdfRenderTimeoutMs,
      }),
    ),
    ollama: new OllamaClient({
      baseUrl: config.ollama.baseUrl,
      ocrModel: config.ollama.ocrModel,
      embeddingModel: config.ollama.embeddingModel,
      dimensions: config.embeddingDimensions,
      numContext: config.ollama.numContext,
      onTruncated: (pageIndex) => logger.warn('ocr_page_truncated', { pageIndex }),
    }),
    mappingVersion: config.archiveMapping.version,
    embeddingDimensions: config.embeddingDimensions,
    chunkMaxCharacters: config.limits.chunkMaxChars,
    chunkOverlapCharacters: config.limits.chunkOverlapChars,
    maxAttempts: config.retries.maxAttempts,
    retryBaseMs: config.retries.baseMs,
    retryMaxMs: config.retries.maxMs,
    logger,
  });

  try {
    await pipeline.preflight();
    if (command === 'preflight') return;
    const options = parseIngestArguments(argumentsList);
    if (options.dryRun) {
      const rows = options.archiveId
        ? [{ archiveId: options.archiveId }]
        : await pipeline.preview(options.afterId, options.limit);
      console.log(JSON.stringify({ dryRun: true, count: rows.length, archiveIds: rows.map((row) => row.archiveId) }));
      return;
    }
    const results = options.archiveId
      ? [await pipeline.ingest({ archiveId: options.archiveId, sourceClaimId: 0, fileName: `archive-${options.archiveId}` })]
      : await pipeline.ingestBatch(options.afterId, options.limit);
    console.log(JSON.stringify({ completed: results.filter((result) => result.outcome === 'completed').length, results }));
    if (results.some((result) => result.outcome === 'failed')) process.exitCode = 1;
  } finally {
    await Promise.allSettled([archiveReader.close(), ragStore.close()]);
  }
}

function parseIngestArguments(argumentsList: string[]): IngestArguments {
  let archiveId: number | undefined;
  let afterId = 0;
  let limit = 20;
  let dryRun = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (argument === '--archive-id') {
      archiveId = parsePositiveInteger(value, argument);
      index += 1;
    } else if (argument === '--after-id') {
      afterId = parseNonNegativeInteger(value, argument);
      index += 1;
    } else if (argument === '--limit') {
      limit = parsePositiveInteger(value, argument);
      index += 1;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else {
      usage(`Unknown ingest argument: ${argument}`);
    }
  }
  if (limit > 1_000) usage('--limit must be no more than 1000');
  return { ...(archiveId ? { archiveId } : {}), afterId, limit, dryRun };
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) usage(`${name} must be a positive integer`);
  return number;
}

function parseNonNegativeInteger(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) usage(`${name} must be a non-negative integer`);
  return number;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('Usage: cli preflight | cli ingest [--archive-id N | --after-id N --limit N] [--dry-run]');
  process.exit(2);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'fatal', ...sanitizeError(error) }));
  process.exitCode = 1;
});
