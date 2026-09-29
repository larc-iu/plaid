// Logical operations (audit-log grouping) — network-free paths.
//
// A batch queues operations instead of sending them, so we can assert the
// `?group-id=` / `group-message` params are stamped on each queued op's path
// without a live server. The server-side fold is covered by plaid-core's
// operation-group-test.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';
import { reportRequestEvent } from '../src/services.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeClient() {
  return new PlaidClient('http://localhost:0', 'dummy-token');
}

function queue(client) {
  const b = client.batch();
  b.spans.setMetadata('S1', { a: 1 });
  b.spans.setMetadata('S2', { b: 2 });
  const paths = b.operations.map(op => op.path);
  b.abort();
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
  await client.spans.setMetadata('S1', { a: 1 });
  await client.endOperation('Merged 3 morphemes');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].method, 'PATCH');
  assert.ok(calls[1].url.endsWith(`/api/v1/operation-groups/${id}`));
  assert.deepStrictEqual(JSON.parse(calls[1].body), { message: 'Merged 3 morphemes' });
});

// The group is made by the first of its writes the server takes. One whose
// only write was refused was never made, and relabelling it 404ed (REV of
// F-REPAIR: every refused repair logged a 404).
test('endOperation(message) skips the PATCH when every write of the group was refused', async () => {
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method });
    return {
      ok: false, status: 409,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ error: 'Document version mismatch' }), text: async () => '',
    };
  };
  client.beginOperation('Repair on open');
  await assert.rejects(client.spans.setMetadata('S1', { a: 1 }));
  await client.endOperation('Repaired 2 words');
  assert.deepStrictEqual(calls.map((c) => c.method), ['PUT']);
});

test('a queued write counts once its batch is taken, not when it is queued', async () => {
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method });
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => [{ status: 200, body: {} }], text: async () => '',
    };
  };
  client.beginOperation('Merge');
  queue(client);
  assert.strictEqual(client.operationGroup.written, false);
  await client.batched(async (b) => {
    b.spans.setMetadata('S1', { a: 1 });
  });
  await client.endOperation('Merged');
  assert.deepStrictEqual(calls.map((c) => c.method), ['POST', 'PATCH']);
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
    await client.spans.setMetadata('S1', { a: 1 });
    setMessage('Merged 2');
  });
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(JSON.parse(calls[1].body), { message: 'Merged 2' });
});

test('GET requests never carry a group-id', async () => {
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({}), text: async () => '',
    };
  };
  client.beginOperation('x');
  await client.spans.get('S1');
  assert.strictEqual(calls.length, 1);
  assert.ok(!calls[0].includes('group-id'));
  assert.strictEqual(client.operationGroup.written, false);
});

// Shaped like a write, carrying no project data, never audited: a lock taken
// or renewed, a stopped service request, a service reporting itself, an admin
// control, and the query that travels as a POST. Stamping one does nothing
// server-side and marks the group written, which promises a group nothing ever
// created. The lock beat that renews a held lock puts a POST inside every long
// operation, so this is not a corner case.
test('an out-of-band signal never joins the operation', async () => {
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method });
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({}), text: async () => '',
    };
  };
  const id = client.beginOperation('Parse the document');

  await client.documents.acquireLock('D1');   // taking the lock
  await client.documents.renewLock('D1', 'L1'); // the keep-alive beat
  await client.documents.releaseLock('D1', 'L1');
  await client.messages.cancelServiceRequest('P1', 'R1');
  await reportRequestEvent(client, 'P1', 'R1', { status: 'progress' });
  await client.admin.backup();
  await client.admin.releaseLock('D1');
  await client.admin.clearRateLimits();
  await client.query({ find: ['?t'], where: [] });

  assert.strictEqual(calls.length, 9);
  const stamped = calls.filter(c => c.url.includes('group-id')).map(c => c.url);
  assert.deepStrictEqual(stamped, [], `these signals joined the operation: ${stamped.join(', ')}`);
  assert.strictEqual(client.operationGroup.written, false);

  // So the relabel is skipped rather than PATCHing a group that never
  // materialized.
  await client.endOperation('Parsed 40 sentences');
  assert.strictEqual(calls.length, 9);
  assert.ok(!calls.some(c => c.method === 'PATCH'));
  assert.match(id, UUID_RE); // the id was still minted for the writes that may yet come
});

test('a real write still marks the operation written', async () => {
  // The other side of the same rule: nothing above narrowed what a write does.
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method });
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({}), text: async () => '',
    };
  };
  const id = client.beginOperation('Parse the document');
  await client.documents.acquireLock('D1');
  await client.spans.setMetadata('S1', { a: 1 });
  assert.strictEqual(client.operationGroup.written, true);
  await client.endOperation('Parsed 40 sentences');
  const patches = calls.filter(c => c.method === 'PATCH');
  assert.strictEqual(patches.length, 1);
  assert.ok(patches[0].url.endsWith(`/api/v1/operation-groups/${id}`));
});

test('group params coexist with strict-mode document-version and a per-call auditMessage', () => {
  const client = makeClient();
  client.enterStrictMode('D1');
  client.documentVersions['D1'] = 7;
  const id = client.beginOperation('Combined');
  const b = client.batch();
  b.spans.setMetadata('S1', { a: 1 }, 'Step {spanId}');
  const [path] = b.operations.map(op => op.path);
  b.abort();
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

// A broadcast message is not written anywhere, so it has no History entry to
// join. Sent inside an operation it once took the group stamp and marked the
// group written, and the relabel then PATCHed a group that never existed. It
// stays batchable, so a message queued after the writes still goes out after
// them, only without the stamp.
test('a broadcast message never joins the operation, sent or queued', async () => {
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method });
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({}), text: async () => '',
    };
  };
  client.beginOperation('Parse');
  await client.messages.sendMessage('P1', { purpose: 'parsed' });
  assert.strictEqual(calls.length, 1);
  assert.ok(!calls[0].url.includes('group-id'), calls[0].url);
  assert.strictEqual(client.operationGroup.written, false);

  const b = client.batch();
  b.spans.setMetadata('S1', { a: 1 });
  b.messages.sendMessage('P1', { purpose: 'parsed' });
  const [write, message] = b.operations.map(op => op.path);
  b.abort();
  assert.ok(write.includes('group-id='), write);
  assert.ok(message.endsWith('/api/v1/projects/P1/message'), message);
  assert.ok(!message.includes('group-id'), message);

  // The label parameter is gone: a second argument after the data is not a
  // History label.
  assert.strictEqual(client.messages.sendMessage.length, 2);
});

// The ruling's example: an assistant wraps "the parse finished" in an
// operation and writes nothing else. Sent directly, queued on a submitted
// batch, or from a nested operation, the message leaves the operation
// unwritten, so the refined label is never PATCHed to a group that does not
// exist.
test('an operation that only sends messages asks for no relabel', async () => {
  const client = makeClient();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const batch = u.pathname === '/api/v1/batch' ? JSON.parse(opts.body).map(op => op.path) : null;
    calls.push({ method: opts.method, path: u.pathname, batch });
    const body = batch ? batch.map(() => ({ status: 200, headers: {}, body: {} })) : {};
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body, text: async () => '',
    };
  };
  await client.withOperation('Parse', async (setMessage) => {
    await client.batched(async (b) => {
      b.messages.sendMessage('P1', { purpose: 'parsed' });
    });
    await client.messages.sendMessage('P1', { purpose: 'parsed' });
    await client.withOperation('Inner', async (setInner) => {
      await client.messages.sendMessage('P1', { purpose: 'parsed' });
      setInner('Inner done');
    });
    setMessage('Parsed');
  });
  assert.deepStrictEqual(calls, [
    { method: 'POST', path: '/api/v1/batch', batch: ['/api/v1/projects/P1/message'] },
    { method: 'POST', path: '/api/v1/projects/P1/message', batch: null },
    { method: 'POST', path: '/api/v1/projects/P1/message', batch: null },
  ]);
});

// Kind and ref: what a study of the log counts by and joins on. Stamped on
// every write beside the id, like the message, and carried to a service.
const paramOf = (path, name) => new URL('http://x' + path).searchParams.get(name);

test('beginOperation stamps group-kind and group-ref on every write', async () => {
  const client = makeClient();
  client.beginOperation('Assistant: gloss', { kind: 'assistant-plan', ref: 'conv:c/plan:p' });
  const paths = queue(client);
  assert.ok(paths.every((p) => paramOf(p, 'group-kind') === 'assistant-plan'));
  assert.ok(paths.every((p) => paramOf(p, 'group-ref') === 'conv:c/plan:p'));
  await client.endOperation();
  assert.ok(queue(client).every((p) => !p.includes('group-kind') && !p.includes('group-ref')));
});

test('an operation with no kind or ref sends neither', () => {
  const client = makeClient();
  client.beginOperation('Plain');
  assert.ok(queue(client).every((p) => !p.includes('group-kind') && !p.includes('group-ref')));
});

test('withOperation takes kind and ref after the function', async () => {
  const client = makeClient();
  let paths;
  await client.withOperation('Import ELAN corpus', async () => { paths = queue(client); }, {
    kind: 'import',
    ref: 'format:elan',
  });
  assert.ok(paths.every((p) => paramOf(p, 'group-kind') === 'import'));
  assert.ok(paths.every((p) => paramOf(p, 'group-ref') === 'format:elan'));
});

test('a nested operation keeps the outer kind and ref', async () => {
  const client = makeClient();
  client.beginOperation('outer', { kind: 'assistant-plan', ref: 'plan:1' });
  let paths;
  await client.withOperation('inner', async () => { paths = queue(client); }, { kind: 'service-run', ref: 'service:x' });
  assert.ok(paths.every((p) => paramOf(p, 'group-kind') === 'assistant-plan' && paramOf(p, 'group-ref') === 'plan:1'));
  await client.endOperation();
});

test('requestService carries the kind and ref to the service', async () => {
  const client = makeClient();
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: false, status: 500, statusText: 'nope' };
  };
  const id = client.beginOperation('Transcribe', { kind: 'service-run', ref: 'service:asr' });
  await assert.rejects(client.messages.requestService('P', 'svc', { documentId: 'D' }, 1000));
  assert.deepStrictEqual(sent, {
    'document-id': 'D',
    'operation-group': { id, message: 'Transcribe', kind: 'service-run', ref: 'service:asr' },
  });
  await client.endOperation();
});

// One client holds one open operation. An editor write still saving when the
// user approves an assistant plan or starts a service run held it open, so the
// request carried it, the service joined it, and the whole plan or run was
// recorded as that edit, under the edit's kind. A request made with
// `noOperation` never carries one, so the service starts its own.
test('requestService with noOperation carries no open operation', async () => {
  const client = makeClient();
  let sent = null;
  globalThis.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: false, status: 500, statusText: 'nope' };
  };
  client.beginOperation('Gloss', { kind: 'guess-adoption' });
  await assert.rejects(
    client.messages.requestService('P', 'svc', { approve: { planId: 'p1' } }, 1000, undefined, undefined, {
      noOperation: true,
    }),
  );
  assert.deepStrictEqual(sent, { approve: { 'plan-id': 'p1' } });
  await client.endOperation();
});
