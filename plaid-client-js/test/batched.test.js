// Tests for client.batched() — the network-free paths (empty submit +
// abort-on-throw + opens batch mode). The happy submit path needs a live
// server and is covered by integration use.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';

function makeClient() {
  return new PlaidClient('http://localhost:0', 'dummy-token');
}

test('empty block submits nothing and leaves no batch open', async () => {
  const client = makeClient();
  const results = await client.batched(async () => { /* queue nothing */ });
  assert.deepStrictEqual(results, []);
  assert.strictEqual(client.isBatchMode(), false);
});

test('a throw inside the block aborts and clears the batch', async () => {
  const client = makeClient();
  let inside = null;
  await assert.rejects(
    client.batched(async () => {
      inside = client.isBatchMode();        // batch is open inside
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.strictEqual(inside, true);
  // The half-open batch must be dropped so later plain calls don't queue.
  assert.strictEqual(client.isBatchMode(), false);
  assert.deepStrictEqual(client.batchOperations, []);
});

test('the block runs with batch mode open', async () => {
  const client = makeClient();
  let inside = null;
  await client.batched(async () => { inside = client.isBatchMode(); });
  assert.strictEqual(inside, true);
  assert.strictEqual(client.isBatchMode(), false);
});
