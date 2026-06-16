// Tests for custom audit-log message support — network-free paths.
//
// Batch mode queues operations instead of sending them, so we can assert the
// `?audit-message=` query param is appended to each queued op's path without a
// live server. Server-side templating of `{param}` placeholders is covered by
// plaid-core's audit-message-test.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';

function makeClient() {
  return new PlaidClient('http://localhost:0', 'dummy-token');
}

// Queue two same-span metadata patches in a batch and return their paths.
function queue(client) {
  client.beginBatch();
  client.spans.setMetadata('S1', { a: 1 });
  client.spans.setMetadata('S2', { b: 2 });
  const paths = client.batchOperations.map(op => op.path);
  client.abortBatch();
  return paths;
}

test('withAuditMessage appends to every op', async () => {
  const client = makeClient();
  let paths;
  await client.withAuditMessage('Approve {spanId}', async () => { paths = queue(client); });
  assert.ok(paths.every(p => p.includes('audit-message=Approve%20%7BspanId%7D')));
});

test('withAuditMessage restores the previous message (nesting)', async () => {
  const client = makeClient();
  await client.withAuditMessage('outer', async () => {
    await client.withAuditMessage('inner', async () => {
      assert.ok(queue(client)[0].includes('audit-message=inner'));
    });
    assert.ok(queue(client)[0].includes('audit-message=outer'));
  });
  assert.ok(queue(client).every(p => !p.includes('audit-message')));
});

test('withAuditMessage returns the callback result', async () => {
  const client = makeClient();
  const result = await client.withAuditMessage('msg', async () => 42);
  assert.strictEqual(result, 42);
});

test('setAuditMessage / clearAuditMessage', () => {
  const client = makeClient();
  client.setAuditMessage('manual');
  assert.ok(queue(client)[0].includes('audit-message=manual'));
  client.clearAuditMessage();
  assert.ok(queue(client).every(p => !p.includes('audit-message')));
});

test('GET requests never carry an audit-message', () => {
  const client = makeClient();
  client.setAuditMessage('msg');
  client.beginBatch();
  client.spans.get('S1');
  const paths = client.batchOperations.map(op => op.path);
  client.abortBatch();
  assert.ok(paths.every(p => !p.includes('audit-message')));
});

test('special characters are URL-encoded', async () => {
  const client = makeClient();
  let path;
  await client.withAuditMessage('a & b = c', async () => { path = queue(client)[0]; });
  assert.ok(path.includes('a%20%26%20b%20%3D%20c'));
});
