// Tests for the 503 "Database busy" retry.
//
// Plaid serializes writers on a single SQLite write lock. A writer that can't
// get it within the server's busy_timeout is refused with 503, and that
// refusal is definitive — the transaction never opened, or was rolled back
// whole — so repeating the request is safe. Without this retry a long import
// dies partway through the moment anyone else writes.

import { test } from 'node:test';
import assert from 'node:assert';
import { retryWhileBusy, BUSY_RETRIES } from '../src/http.js';

const busy = () =>
  Object.assign(new Error('HTTP 503 Database busy'), { status: 503 });

// Keep the tests instant: the backoff is what we're bounding, not measuring.
const fast = { baseDelayMs: 0 };

test('a call that succeeds is not retried', async () => {
  let attempts = 0;
  const result = await retryWhileBusy(async () => {
    attempts += 1;
    return 'ok';
  }, fast);
  assert.strictEqual(result, 'ok');
  assert.strictEqual(attempts, 1);
});

test('a 503 is retried until it succeeds', async () => {
  let attempts = 0;
  const result = await retryWhileBusy(async () => {
    attempts += 1;
    if (attempts < 3) throw busy();
    return 'ok';
  }, fast);
  assert.strictEqual(result, 'ok');
  assert.strictEqual(attempts, 3);
});

test('a persistent 503 gives up after the retry budget and rethrows', async () => {
  let attempts = 0;
  await assert.rejects(
    retryWhileBusy(async () => {
      attempts += 1;
      throw busy();
    }, fast),
    (e) => e.status === 503,
  );
  assert.strictEqual(
    attempts,
    BUSY_RETRIES + 1,
    'one initial attempt plus the budget',
  );
});

test('any other failure is rethrown immediately, never retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 500, undefined]) {
    let attempts = 0;
    await assert.rejects(
      retryWhileBusy(async () => {
        attempts += 1;
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      }, fast),
      (e) => e.status === status,
    );
    assert.strictEqual(attempts, 1, `status ${status} must not be retried`);
  }
});

test('backoff grows and is jittered, so collided clients do not stay in lockstep', async () => {
  const delays = [];
  await assert.rejects(
    retryWhileBusy(
      async () => {
        throw busy();
      },
      {
        baseDelayMs: 0,
        onRetry: ({ delay, attempt }) => delays.push({ delay, attempt }),
      },
    ),
    (e) => e.status === 503,
  );
  assert.strictEqual(delays.length, BUSY_RETRIES);
  assert.deepStrictEqual(
    delays.map((d) => d.attempt),
    [1, 2, 3, 4],
  );

  // With a real base delay the window doubles each time; full jitter keeps
  // each draw inside [0.5, 1.5) of that step.
  const seen = [];
  await assert.rejects(
    retryWhileBusy(
      async () => {
        throw busy();
      },
      {
        baseDelayMs: 1,
        onRetry: ({ delay }) => seen.push(delay),
      },
    ),
    (e) => e.status === 503,
  );
  seen.forEach((delay, i) => {
    const step = 2 ** i;
    assert.ok(
      delay >= Math.round(step * 0.5) && delay <= Math.round(step * 1.5),
      `retry ${i} delay ${delay} outside the jittered window for step ${step}`,
    );
  });
});

test('the client gives batch submissions their own, longer timeout', async () => {
  const { PlaidClient } = await import('../src/index.js');
  // Aborting a batch does not stop the server's transaction, so the batch
  // budget must not be the short per-request one.
  const dflt = new PlaidClient('http://localhost:0', 't');
  assert.ok(dflt.batchTimeout > dflt.timeout);
  // An explicit `timeout` still governs both unless batchTimeout is given.
  const explicit = new PlaidClient('http://localhost:0', 't', {
    timeout: 5000,
  });
  assert.strictEqual(explicit.batchTimeout, 5000);
  const both = new PlaidClient('http://localhost:0', 't', {
    timeout: 5000,
    batchTimeout: 60000,
  });
  assert.strictEqual(both.batchTimeout, 60000);
});
