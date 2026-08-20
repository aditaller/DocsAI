export type ErrorCode =
  | 'configuration'
  | 'preflight'
  | 'source_not_found'
  | 'unsupported_file'
  | 'source_limit'
  | 'renderer'
  | 'ollama'
  | 'azure_layout'
  | 'database'
  | 'unknown';

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

const secretPatterns = [
  /((?:password|pwd|user id|uid)\s*=\s*)[^;,\s]+/gi,
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi,
  /(access[_-]?token|authorization)\s*[:=]\s*\S+/gi,
];

export function sanitizeError(error: unknown): { code: ErrorCode; message: string; retryable: boolean } {
  const fallback = { code: 'unknown' as const, message: 'Unexpected ingestion failure', retryable: false };
  const source =
    error instanceof ServiceError
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : error instanceof Error
        ? { code: 'unknown' as const, message: error.message, retryable: isTransientError(error) }
        : fallback;

  let message = source.message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
  for (const pattern of secretPatterns) {
    message = message.replace(pattern, '$1[REDACTED]');
  }
  return { ...source, message };
}

export function isTransientError(error: unknown): boolean {
  if (error instanceof ServiceError) return error.retryable;
  const candidate = error as { code?: unknown; status?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const status = typeof candidate?.status === 'number' ? candidate.status : 0;
  return (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', '40001', '40P01'].includes(code)
  );
}
