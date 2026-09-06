// documents.restore builds the one request the server needs: the moment to
// go back to, whether it is a dry run, and the optional audit message. Batch
// mode queues the request, so the path can be checked without a server.

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

test('restore posts the moment to go back to', () => {
  const [op] = queued((c) => c.documents.restore('D1', '2026-06-01T12:00:00Z'));
  assert.equal(op.method, 'POST');
  assert.ok(op.path.startsWith('/api/v1/documents/D1/restore?'));
  assert.ok(op.path.includes('as-of=2026-06-01T12%3A00%3A00Z'));
  assert.ok(!op.path.includes('dry-run'));
});

test('a dry run says so, and the audit message rides along', () => {
  const [op] = queued((c) =>
    c.documents.restore('D1', '2026-06-01T12:00:00Z', { dryRun: true }, 'Restore to yesterday'),
  );
  assert.ok(op.path.includes('dry-run=true'));
  assert.ok(op.path.includes('audit-message=Restore%20to%20yesterday'));
});
