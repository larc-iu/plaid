// Tests for client.batched() — the network-free paths (empty submit,
// abort-on-throw, what the block is handed). The happy submit path needs a
// live server and is covered by integration use.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient, MAX_BATCH_OPS } from '../src/index.js';

function makeClient() {
  return new PlaidClient('http://localhost:0', 'dummy-token');
}

test('empty block submits nothing', async () => {
  const client = makeClient();
  const results = await client.batched(async () => { /* queue nothing */ });
  assert.deepStrictEqual(results, []);
});

test('the block is handed a batch of this client, with the same bundles', async () => {
  const client = makeClient();
  let batch = null;
  await client.batched(async (b) => { batch = b; });
  assert.strictEqual(batch.client, client);
  assert.strictEqual(batch.baseUrl, client.baseUrl);
  assert.strictEqual(typeof batch.tokens.create, 'function');
  assert.notStrictEqual(batch.tokens, client.tokens);
});

test('a throw inside the block aborts the batch and nothing is sent', async () => {
  const client = makeClient();
  let batch = null;
  await assert.rejects(
    client.batched(async (b) => {
      batch = b;
      b.tokens.create('tl-1', 'text-1', 0, 3, 1);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.strictEqual(batch.open, false);
  assert.deepStrictEqual(batch.operations, []);
});

test('a batch is not nestable', async () => {
  const client = makeClient();
  await assert.rejects(
    client.batched(async (b) => { await b.batched(async () => {}); }),
    /not nestable/,
  );
  assert.throws(() => client.batch().batch(), /not nestable/);
});

test('a batch submits or aborts once', async () => {
  const client = makeClient();
  const b = client.batch();
  b.abort();
  await assert.rejects(b.submit(), /already submitted or aborted/);
  await assert.rejects(b.tokens.create('tl-1', 'text-1', 0, 3, 1), /already submitted or aborted/);
});

// The server caps a batch at MAX_BATCH_OPS. A larger one is sent as
// consecutive requests with the results concatenated in queue order, so a
// repair or bulk edit over a big document never fails on its size alone.
test('a batch over the server cap goes as consecutive requests, results in order', async () => {
  const client = makeClient();
  const sizes = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    const ops = JSON.parse(opts.body);
    sizes.push(ops.length);
    const body = ops.map((op) => ({ status: 200, body: { path: op.path } }));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const n = MAX_BATCH_OPS + 1;
    const results = await client.batched(async (b) => {
      for (let i = 0; i < n; i++) b.documents.update(`doc-${i}`, `name-${i}`);
    });
    assert.deepStrictEqual(sizes, [MAX_BATCH_OPS, 1]);
    assert.strictEqual(results.length, n);
    assert.ok(results[0].body.path.endsWith('doc-0'));
    assert.ok(results[n - 1].body.path.endsWith(`doc-${n - 1}`));
  } finally {
    global.fetch = realFetch;
  }
});
