// Logical operations (audit-log grouping) — network-free paths.
//
// Batch mode queues operations instead of sending them, so we can assert the
// `?group-id=` / `group-message` params are stamped on each queued op's path
// without a live server. The server-side fold is covered by plaid-core's
// operation-group-test.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeClient() {
  return new PlaidClient('http://localhost:0', 'dummy-token');
}

function queue(client) {
  client.beginBatch();
  client.spans.setMetadata('S1', { a: 1 });
  client.spans.setMetadata('S2', { b: 2 });
  const paths = client.batchOperations.map(op => op.path);
  client.abortBatch();
  return paths;
}

const groupIdOf = (path) => new URL('http://x' + path).searchParams.get('group-id');

test('beginOperation stamps group-id + group-message on every write', () => {
  const client = makeClient();
  const id = client.beginOperation('Merge morphemes');
  assert.match(id, UUID_RE);
  const paths = queue(client);
  assert.ok(paths.every(p => groupIdOf(p) === id));
  assert.ok(paths.every(p => p.includes('group-message=Merge%20morphemes')));
});

test('endOperation (no refine) is local and clears the group', async () => {
  const client = makeClient();
  client.beginOperation('x');
  queue(client);
  globalThis.fetch = async () => { throw new Error('endOperation must not send a request'); };
  await client.endOperation();
  assert.strictEqual(client.operationGroup, null);
  assert.ok(queue(client).every(p => !p.includes('group-id')));
});

test('endOperation(message) PATCHes the group when something was written', async () => {
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body });
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({}), text: async () => '',
    };
  };
  const id = client.beginOperation('Merge morphemes');
  queue(client); // queued (and aborted) — still counts as "written" for the client
  await client.endOperation('Merged 3 morphemes');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'PATCH');
  assert.ok(calls[0].url.endsWith(`/api/v1/operation-groups/${id}`));
  assert.deepStrictEqual(JSON.parse(calls[0].body), { message: 'Merged 3 morphemes' });
});

test('endOperation(message) skips the PATCH when nothing was written', async () => {
  const client = makeClient();
  globalThis.fetch = async () => { throw new Error('unexpected request'); };
  client.beginOperation('nothing');
  await client.endOperation('still nothing');
  assert.strictEqual(client.operationGroup, null);
});

test('endOperation(message) tolerates a 404 (group never materialized)', async () => {
  const client = makeClient();
  globalThis.fetch = async () => ({
    ok: false, status: 404, statusText: 'Not Found',
    headers: { get: () => 'application/json' },
    json: async () => ({ error: 'Operation group not found' }), text: async () => '',
  });
  client.beginOperation('x');
  queue(client);
  await client.endOperation('y'); // must not throw
});

test('nested beginOperation flattens into the outer operation', async () => {
  const client = makeClient();
  const outer = client.beginOperation('outer');
  const inner = client.beginOperation('inner');
  assert.strictEqual(inner, outer);
  assert.ok(queue(client).every(p => groupIdOf(p) === outer && p.includes('group-message=outer')));
  await client.endOperation('inner refine is ignored');
  assert.ok(client.operationGroup, 'still open after the inner end');
  assert.ok(queue(client).every(p => groupIdOf(p) === outer));
  globalThis.fetch = async () => { throw new Error('no request expected: no refine at the outer end'); };
  await client.endOperation();
  assert.strictEqual(client.operationGroup, null);
});

test('withOperation scopes the group, returns the result, and ends on throw', async () => {
  const client = makeClient();
  let paths;
  const result = await client.withOperation('Tokenize', async () => { paths = queue(client); return 42; });
  assert.strictEqual(result, 42);
  assert.ok(paths.every(p => p.includes('group-id=') && p.includes('group-message=Tokenize')));
  assert.strictEqual(client.operationGroup, null);

  await assert.rejects(client.withOperation('boom', async () => { queue(client); throw new Error('boom'); }), /boom/);
  assert.strictEqual(client.operationGroup, null);
});

test('withOperation setMessage refines the label at the end', async () => {
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts.body });
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({}), text: async () => '',
    };
  };
  await client.withOperation('Merge', async (setMessage) => {
    queue(client);
    setMessage('Merged 2');
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].body), { message: 'Merged 2' });
});

test('GET requests never carry a group-id', () => {
  const client = makeClient();
  client.beginOperation('x');
  client.beginBatch();
  client.spans.get('S1');
  const paths = client.batchOperations.map(op => op.path);
  client.abortBatch();
  assert.ok(paths.every(p => !p.includes('group-id')));
  assert.strictEqual(client.operationGroup.written, false);
});

test('group params coexist with strict-mode document-version and a per-call auditMessage', () => {
  const client = makeClient();
  client.enterStrictMode('D1');
  client.documentVersions['D1'] = 7;
  const id = client.beginOperation('Combined');
  client.beginBatch();
  client.spans.setMetadata('S1', { a: 1 }, 'Step {spanId}');
  const [path] = client.batchOperations.map(op => op.path);
  client.abortBatch();
  const params = new URL('http://x' + path).searchParams;
  assert.strictEqual(params.get('document-version'), '7');
  assert.strictEqual(params.get('audit-message'), 'Step {spanId}');
  assert.strictEqual(params.get('group-id'), id);
  assert.strictEqual(params.get('group-message'), 'Combined');
});

test('beginOperation can adopt an existing group id (service joining the requester)', () => {
  const client = makeClient();
  const id = client.beginOperation('outer label', { id: '11111111-2222-4333-8444-555555555555' });
  assert.strictEqual(id, '11111111-2222-4333-8444-555555555555');
  assert.ok(queue(client).every(p => groupIdOf(p) === id));
});

test('requestService propagates the open operation in the payload', async () => {
  const client = makeClient();
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: false, status: 500, statusText: 'nope' };
  };
  const id = client.beginOperation('Re-transcribe');
  await assert.rejects(client.messages.requestService('P', 'svc', { documentId: 'D' }, 1000));
  assert.deepStrictEqual(sent, {
    'document-id': 'D',
    'operation-group': { id, message: 'Re-transcribe' },
  });
  await client.endOperation();
  sent = null;
  await assert.rejects(client.messages.requestService('P', 'svc', { documentId: 'D' }, 1000));
  assert.deepStrictEqual(sent, { 'document-id': 'D' }, 'no operation open → nothing injected');
});
