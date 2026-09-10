// documents.copy builds one POST carrying the new name and, when it is
// turned off, the media flag. Batch mode queues the request, so the path
// and body can be checked without a server.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';

function queued(fn) {
  const client = new PlaidClient('http://localhost:0', 'dummy-token');
  client.beginBatch();
  fn(client);
  const ops = client.batchOperations.slice();
  client.abortBatch();
  return ops;
}

test('copy posts the new name to the document', () => {
  const [op] = queued((c) => c.documents.copy('D1', 'Doc, copy'));
  assert.equal(op.method, 'POST');
  assert.equal(op.path, '/api/v1/documents/D1/copy');
  assert.deepEqual(op.body, { name: 'Doc, copy' });
});

test('leaving the media behind says so, and the audit message rides along', () => {
  const [op] = queued((c) =>
    c.documents.copy('D1', 'Doc, copy', { includeMedia: false }, 'Copy for the class'),
  );
  assert.deepEqual(op.body, { name: 'Doc, copy', 'include-media': false });
  assert.ok(op.path.includes('audit-message=Copy%20for%20the%20class'));
});
