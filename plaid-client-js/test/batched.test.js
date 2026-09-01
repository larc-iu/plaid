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

// A read must never be swallowed by whatever batch happens to be open on the
// shared client: it returns nothing to its caller until submit, and the server
// runs a batched sub-request against the batch's tx Connection, where a query
// throws and takes every write in the batch down with it. Queries therefore go
// straight over the wire (here: to a dead port, so a rejection proves it left
// the queue rather than joining it).
test('query does not join an open batch', async () => {
  const client = makeClient();
  let queuedDuring = null;
  let queryFailed = false;
  await client.batched(async () => {
    client.tokens.create('tl-1', 'text-1', 0, 3, 1);
    await client.query({ find: ['?t'], where: [['token', '?t', {}]] }).catch(() => {
      queryFailed = true; // network error from the dead port: it really went out
    });
    queuedDuring = client.batchOperations.map((op) => op.path.split('?')[0]);
  }).catch(() => {});
  assert.strictEqual(queryFailed, true);
  assert.deepStrictEqual(queuedDuring, ['/api/v1/tokens']);
});

test('the block runs with batch mode open', async () => {
  const client = makeClient();
  let inside = null;
  await client.batched(async () => { inside = client.isBatchMode(); });
  assert.strictEqual(inside, true);
  assert.strictEqual(client.isBatchMode(), false);
});
