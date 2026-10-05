// A query waits longer than core's own query limit (30 s), so a query too
// broad reaches the caller as core's 408. Before, the client's 30 s timeout
// and core's 30 s limit raced, the client gave up first, and the search page
// said "Failed to reach the server" for a query that had only timed out.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';
import { DEFAULT_QUERY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, queryTimeout } from '../src/http.js';

// The timeout each request is sent with, read from AbortSignal.timeout.
async function sentTimeouts(client, call) {
  const seen = [];
  const realTimeout = AbortSignal.timeout;
  const realFetch = globalThis.fetch;
  AbortSignal.timeout = (ms) => {
    seen.push(ms);
    return realTimeout.call(AbortSignal, ms);
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ results: [], columns: [], count: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    await call(client);
  } finally {
    AbortSignal.timeout = realTimeout;
    globalThis.fetch = realFetch;
  }
  return seen;
}

test('the query timeout is longer than core\'s 30 s limit', () => {
  assert.ok(DEFAULT_QUERY_TIMEOUT_MS > 30000);
  assert.ok(DEFAULT_QUERY_TIMEOUT_MS > DEFAULT_TIMEOUT_MS);
});

test('a query is sent with the query timeout, other reads with the client\'s', async () => {
  const client = new PlaidClient('http://localhost:0', 't');
  assert.deepStrictEqual(
    await sentTimeouts(client, (c) => c.query({ where: [] })),
    [DEFAULT_QUERY_TIMEOUT_MS],
  );
  assert.deepStrictEqual(
    await sentTimeouts(client, (c) => c.projects.get('p')),
    [DEFAULT_TIMEOUT_MS],
  );
});

test('a longer client timeout stands, and a disabled one stays disabled', async () => {
  const long = new PlaidClient('http://localhost:0', 't', { timeout: 90000 });
  assert.deepStrictEqual(await sentTimeouts(long, (c) => c.query({ where: [] })), [90000]);
  const short = new PlaidClient('http://localhost:0', 't', { timeout: 5000 });
  assert.deepStrictEqual(
    await sentTimeouts(short, (c) => c.query({ where: [] })),
    [DEFAULT_QUERY_TIMEOUT_MS],
  );
  for (const timeout of [0, null]) {
    const off = new PlaidClient('http://localhost:0', 't', { timeout });
    assert.strictEqual(queryTimeout(off), timeout);
    assert.deepStrictEqual(await sentTimeouts(off, (c) => c.query({ where: [] })), []);
  }
});
