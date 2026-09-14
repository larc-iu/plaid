// Coverage guard for the batch-mode classification (see the note at the top of
// src/http.js).
//
// `client.batched()` sets ONE flag on the whole client, so a call made while it
// is open is queued no matter which code made it. A browser client is shared by
// an editor, an importer and the app's chrome at once, and four separate reads
// were found queued into other people's batches before the rule was written
// down: the query endpoint, the server info probe, service discovery, and the
// document page the `@` list reads. A queued read answers `{batched: true}`
// instead of data, takes a slot in the batch's results that shifts every
// positional read after it, and server-side runs against the batch's
// transaction connection, where `/query` 500s and rolls back every write.
//
// So: no read is ever queued, and neither is an out-of-band signal. The first
// test discovers every method on the client and proves it. The second names the
// signals, which are shaped like writes and cannot be found by their verb.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaidClient } from '../src/index.js';
import { cancelServiceRequest, reportRequestEvent, discoverServices } from '../src/services.js';

// A stubbed fetch that answers anything with an empty paginated envelope, so a
// probe of a read method runs to completion whatever shape it expects.
function stubFetch(record) {
  globalThis.fetch = async (url, opts = {}) => {
    record.push({ url: String(url), method: opts.method || 'GET' });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      json: async () => ({ entries: [], 'next-cursor': null }),
      text: async () => '{}',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

// Bundles carrying the REST surface. `messages` is covered by the out-of-band
// test below (its methods open streams rather than make plain requests).
const BUNDLES = [
  'vocabLinks', 'vocabLayers', 'relations', 'spanLayers', 'spans', 'server',
  'batch', 'texts', 'users', 'userData', 'apiTokens', 'invites', 'admin',
  'audit', 'tokenLayers', 'documents', 'projects', 'textLayers', 'vocabItems',
  'relationLayers', 'tokens', 'operationGroups', 'comments',
];

test('no read is ever queued into an open batch', async () => {
  process.on('unhandledRejection', () => {});
  const client = new PlaidClient('http://x', 'tok');
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();

  const overTheWire = [];
  const queuedReads = [];
  try {
    const probe = async (label, fn) => {
      const sentBefore = sent.length;
      const queuedBefore = client.batchOperations.length;
      try {
        const out = fn(...Array(Math.max(fn.length, 0)).fill('x'));
        // An async generator is only work once it is iterated.
        if (out && typeof out[Symbol.asyncIterator] === 'function') {
          for await (const _page of out) break;
        } else {
          await out;
        }
      } catch {
        // A probe with fake arguments may reject; what it did with the batch
        // before rejecting is still the thing under test.
      }
      for (const op of client.batchOperations.slice(queuedBefore)) {
        if (op.method === 'GET') queuedReads.push(`${label} -> ${op.path}`);
      }
      for (const req of sent.slice(sentBefore)) {
        if (req.method === 'GET') overTheWire.push(label);
      }
    };

    for (const name of BUNDLES) {
      const bundle = client[name];
      if (!bundle) continue;
      for (const [m, fn] of Object.entries(bundle)) {
        if (typeof fn === 'function') await probe(`${name}.${m}`, fn);
      }
    }
    await probe('query', client.query);
  } finally {
    client.abortBatch();
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(
    queuedReads,
    [],
    `these reads joined the batch instead of going over the wire:\n  ${queuedReads.join('\n  ')}`,
  );
  // The count is the table: every read method on the client answered from the
  // wire with a batch open. It only ever goes up.
  assert.ok(
    overTheWire.length >= 45,
    `expected every read (about 50) to go over the wire, saw ${overTheWire.length}: ${overTheWire.join(', ')}`,
  );
});

test('an out-of-band signal goes over the wire while a batch is open', async () => {
  const client = new PlaidClient('http://x', 'tok');
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();

  // Each of these is shaped like a write and carries no project data. Its
  // whole value is that it happens now: queued, it happens when the batch
  // submits, or never if the batch aborts, while its caller reads success.
  const signals = [
    // The assistant's Stop button, pressed during an import.
    ['cancel a service request', () => cancelServiceRequest(client, 'p1', 'r1')],
    // A service reporting from inside its own batch of writes.
    ['report a service request event', () =>
      reportRequestEvent(client, 'p1', 'r1', { status: 'progress' })],
    // Discovery, which the availability probe polls.
    ['discover services', () => discoverServices(client, 'p1')],
    // A lock taken at submit time is taken after every write it guards.
    ['acquire a document lock', () => client.documents.acquireLock('d1')],
    ['release a document lock', () => client.documents.releaseLock('d1')],
    // Admin actions on the server itself, none of them project data.
    ['take a backup', () => client.admin.backup()],
    ['drop a stranded lock', () => client.admin.releaseLock('d1')],
    ['clear rate limits', () => client.admin.clearRateLimits()],
  ];

  try {
    for (const [label, fn] of signals) {
      const before = sent.length;
      const queuedBefore = client.batchOperations.length;
      await fn();
      assert.equal(sent.length, before + 1, `${label} did not go over the wire`);
      assert.equal(
        client.batchOperations.length,
        queuedBefore,
        `${label} was queued into the batch`,
      );
    }
  } finally {
    client.abortBatch();
    globalThis.fetch = realFetch;
  }
});

test('a write of project data still queues', async () => {
  const client = new PlaidClient('http://x', 'tok');
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();
  try {
    await client.tokens.create('tl1', 't1', 0, 5);
    await client.spans.update('s1', 'NOUN');
    await client.relations.delete('r1');
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(sent.length, 0, 'a queued write must not reach the wire');
  assert.deepEqual(
    client.batchOperations.map((op) => op.method),
    ['POST', 'PATCH', 'DELETE'],
  );
  client.abortBatch();
});
