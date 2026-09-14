import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaidClient } from '../src/index.js';

// A client whose request layer is replaced, so the test sees the options every
// userData call was made with rather than the wire.
function makeClient() {
  const calls = [];
  const client = new PlaidClient('http://example.test', 'tok');
  client._request = (method, path, options = {}) => {
    calls.push({ method, path, options });
    return Promise.resolve({ entries: [], nextCursor: null });
  };
  return { client, calls };
}

// The assistant panel is app chrome in both SPAs, so its conversation reads
// fire on the same client a UD import or an IGT bulk edit is batching on. A
// queued read answered `{batched: true}`, which the sidebar took for the entry
// list and threw on (`(entries || []).map is not a function`), and it also took
// a slot in the batch's results, shifting the indices the importer reads its
// created ids back by.
test('a userData read goes over the wire while a batch is open', async () => {
  const { client, calls } = makeClient();
  client.isBatching = true;

  await client.userData.list('u1', { prefix: 'ud:assistant:' });
  await client.userData.get('u1', 'ud:assistant:p1:meta:c1');

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.options.bypassBatch, true);
  }
});

// The writes keep the opposite answer: they refuse. A preference or a
// transcript saved into someone else's transaction would be rolled back with
// it, so the caller is told rather than left believing it landed.
test('a userData write still refuses an open batch', async () => {
  const client = new PlaidClient('http://example.test', 'tok');
  client.beginBatch();

  await assert.rejects(
    () => client.userData.put('u1', 'k', { a: 1 }),
    /cannot be used in batch mode/,
  );
  await assert.rejects(
    () => client.userData.delete('u1', 'k'),
    /cannot be used in batch mode/,
  );
});
