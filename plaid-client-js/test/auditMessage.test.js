// Tests for the per-call custom audit-log message — network-free paths.
//
// A batch queues operations instead of sending them, so we can assert the
// `?audit-message=` query param is appended to a queued op's path without a
// live server. Server-side templating of `{param}` placeholders is covered by
// plaid-core's audit-message-test. (Scoping a message over MANY writes is the
// job of logical operations — see operation.test.js.)

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';

function makeClient() {
  return new PlaidClient('http://localhost:0', 'dummy-token');
}

// Queue one write (with a per-call message) and one without; return paths.
function queue(client, message) {
  const b = client.batch();
  b.spans.setMetadata('S1', { a: 1 }, message);
  b.spans.setMetadata('S2', { b: 2 });
  const paths = b.operations.map(op => op.path);
  b.abort();
  return paths;
}

test('per-call auditMessage is appended to that op only', () => {
  const [withMsg, without] = queue(makeClient(), 'Approve {spanId}');
  assert.ok(withMsg.includes('audit-message=Approve%20%7BspanId%7D'));
  assert.ok(!without.includes('audit-message'));
});

// A read never joins a batch, so this one is observed on the wire rather than
// in the queue: the fetch is stubbed and the URL it was given is the assertion.
test('GET requests never carry an audit-message', async () => {
  const client = makeClient();
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await client.spans.get('S1');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(urls.length, 1);
  assert.ok(!urls[0].includes('audit-message'));
});

test('special characters are URL-encoded', () => {
  const [path] = queue(makeClient(), 'a & b = c');
  assert.ok(path.includes('a%20%26%20b%20%3D%20c'));
});
