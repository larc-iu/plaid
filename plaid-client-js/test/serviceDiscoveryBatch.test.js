import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverServices } from '../src/services.js';

// A fake client that records the options every request was made with, so the
// test can see whether discovery asked to go over the wire during a batch.
function makeFakeClient() {
  return {
    calls: [],
    isBatching: true,
    async _request(method, path, options = {}) {
      this.calls.push({ method, path, options });
      return [{ serviceId: 'igt:assist:x', online: true }];
    },
  };
}

test('discovery goes over the wire while a batch is open', async () => {
  // The assistant's availability probe polls for 49 seconds after a mount and
  // landed inside long batches (a Grew rewrite, an import), where the request
  // layer answered `{batched: true}`. That object was cached as the service
  // list and every later render threw on `.filter` until a reload.
  const client = makeFakeClient();
  const found = await discoverServices(client, 'p1');
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'GET');
  assert.equal(client.calls[0].path, '/api/v1/projects/p1/services');
  assert.equal(client.calls[0].options.bypassBatch, true);
  assert.deepEqual(found, [{ serviceId: 'igt:assist:x', online: true }]);
});
