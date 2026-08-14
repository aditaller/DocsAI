import { isTransientError } from './errors.js';

export function retryDelayMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // Full jitter avoids a fleet of local scheduled workers retrying in lockstep.
  return Math.floor(exponential * (0.5 + random() * 0.5));
}

export async function retry<T>(
  operation: () => Promise<T>,
  options: { maxAttempts: number; baseMs: number; maxMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === options.maxAttempts) throw error;
      await sleep(retryDelayMs(attempt, options.baseMs, options.maxMs));
    }
  }
  throw lastError;
}
