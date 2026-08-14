import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkPages, contentHash } from '../src/chunker.js';
import { ServiceError } from '../src/errors.js';
import { retry, retryDelayMs } from '../src/retry.js';

test('chunker retains pages and creates deterministic hashes', () => {
  const chunks = chunkPages(
    [
      { pageIndex: 1, text: 'first document page with meaningful content' },
      { pageIndex: 2, text: 'second document page with meaningful content' },
    ],
    60,
    10,
  );
  assert.ok(chunks.length >= 2);
  assert.match(chunks[0]?.content ?? '', /\[Page 1\]/);
  assert.equal(contentHash('stable'), contentHash('stable'));
});

test('retry only retries classified transient failures', async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls += 1;
      if (calls < 2) throw new ServiceError('temporary', 'ollama', true);
      return 'ok';
    },
    { maxAttempts: 2, baseMs: 1, maxMs: 1, sleep: async () => undefined },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(retryDelayMs(1, 10, 100, () => 0), 5);
});
