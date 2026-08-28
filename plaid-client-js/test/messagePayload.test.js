// A message payload is opaque application data, like `metadata` and `config`:
// its keys must reach every listener exactly as the sender wrote them,
// regardless of which language client is reading. Only the envelope around it
// is API surface subject to camelCase recasing.
//
// See the manual's Real-time Messaging > Event Reference.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';
import { eventPayload } from '../src/sse.js';

const PAYLOAD = {
  'case-marker': 'ERG',
  camelCaseKey: 1,
  snake_case_key: 2,
  nested: { 'another-key': [1, { 'deep-key': 'v' }] },
};

test('sendMessage puts the payload on the wire verbatim', async () => {
  // Batch mode captures the fully prepared request body without any network.
  const client = new PlaidClient('http://localhost:0', 'dummy-token');
  client.beginBatch();
  client.messages.sendMessage('11111111-2222-3333-4444-555555555555', PAYLOAD);
  const [op] = client.batchOperations;
  client.abortBatch();

  assert.strictEqual(op.method, 'POST');
  assert.deepStrictEqual(op.body, { body: PAYLOAD });
});

test('a message event hands the payload to the callback verbatim', () => {
  const wire = {
    type: 'message',
    id: 'm1',
    project: 'p1',
    user: 'u@example.com',
    time: '2025-07-09T20:14:36.168Z',
    data: PAYLOAD,
  };
  const seen = eventPayload('message', wire);
  assert.deepStrictEqual(seen.data, PAYLOAD);
  // The envelope still gets the usual treatment.
  assert.strictEqual(seen.user, 'u@example.com');
  assert.strictEqual(seen.type, 'message');
});

test('an audit-log event is transformed normally, `data` rule does not apply', () => {
  const wire = {
    type: 'audit-log',
    id: 'a1',
    projects: ['p1'],
    documents: ['d1'],
    user: 'u@example.com',
    time: '2025-07-09T20:27:59.616Z',
    ops: [{ id: 'a1', type: 'document:update', project: 'p1', document: 'd1', description: 'x' }],
  };
  const seen = eventPayload('audit-log', wire);
  assert.strictEqual(seen.ops.length, 1);
  assert.strictEqual(seen.ops[0].type, 'document:update');
  assert.strictEqual(seen.documents[0], 'd1');
});
