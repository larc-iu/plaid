import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaidClient } from '../src/index.js';

// The assistant panel is app chrome in both SPAs, so its conversation reads
// fire on the same client a UD import or an IGT bulk edit is batching on. Under
// the old one-flag model a queued read answered `{batched: true}`, which the
// sidebar took for the entry list and threw on, and it took a slot in the
// batch's results, shifting the indices the importer read its created ids
// back by. Now a read goes over the wire even when made on the batch.
test('a userData read goes over the wire when made on a batch', async () => {
  const calls = [];
  const client = new PlaidClient('http://example.test', 'tok');
  client._request = (method, path, options = {}) => {
    calls.push({ method, path, options });
    return Promise.resolve({ entries: [], nextCursor: null });
  };
  const b = client.batch();

  await b.userData.list('u1', { prefix: 'ud:assistant:' });
  await b.userData.get('u1', 'ud:assistant:p1:meta:c1');

  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.method, 'GET');
  assert.equal(b.operations.length, 0);
});

// The writes keep the opposite answer: they refuse. A preference or a
// transcript saved into someone else's transaction would be rolled back with
// it, so the caller is told rather than left believing it landed.
test('a userData write refuses a batch', async () => {
  const client = new PlaidClient('http://example.test', 'tok');
  const b = client.batch();

  await assert.rejects(
    () => b.userData.put('u1', 'k', { a: 1 }),
    /cannot be used in a batch/,
  );
  await assert.rejects(
    () => b.userData.delete('u1', 'k'),
    /cannot be used in a batch/,
  );
});
