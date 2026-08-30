// A caller must be able to stop waiting on a long service request (a UI's Stop
// button) and tell that stop apart from a failure. The service is not told: it
// finishes its work and its reply goes nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requestService } from '../src/services.js';

/** An SSE body that emits `events`, then blocks until `hold` resolves. */
function fakeClient(events, hold) {
  const encoder = new TextEncoder();
  const queue = events.slice();
  return {
    baseUrl: 'http://plaid.test',
    token: 't',
    fetchCalls: [],
    async _fetch(url, opts) {
      this.fetchCalls.push(opts);
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            async read() {
              if (queue.length) return { done: false, value: encoder.encode(queue.shift()) };
              await hold;
              return { done: true };
            },
          }),
        },
      };
    },
  };
}

const withFetch = async (client, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = (url, opts) => client._fetch(url, opts);
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

test('aborting the signal rejects with an AbortError', async () => {
  const client = fakeClient([], new Promise(() => {}));
  const controller = new AbortController();
  await withFetch(client, async () => {
    const p = requestService(client, 'p1', 's1', {}, 60000, undefined, controller.signal);
    controller.abort();
    await assert.rejects(p, (e) => e.name === 'AbortError');
  });
});

test('a signal already aborted rejects without opening a request', async () => {
  const client = fakeClient([], new Promise(() => {}));
  const controller = new AbortController();
  controller.abort();
  await withFetch(client, async () => {
    await assert.rejects(
      requestService(client, 'p1', 's1', {}, 60000, undefined, controller.signal),
      (e) => e.name === 'AbortError',
    );
  });
  assert.equal(client.fetchCalls.length, 0, 'nothing was sent');
});

test('a result that arrives first wins: aborting afterwards changes nothing', async () => {
  const client = fakeClient(
    ['event: result\ndata: {"data":{"kind":"turn"}}\n\n'],
    new Promise(() => {}),
  );
  const controller = new AbortController();
  await withFetch(client, async () => {
    const value = await requestService(client, 'p1', 's1', {}, 60000, undefined, controller.signal);
    assert.deepEqual(value, { kind: 'turn' });
    controller.abort(); // settled already, so this must not throw or reject
  });
});

test('without a signal the request behaves as before', async () => {
  const client = fakeClient(
    ['event: result\ndata: {"data":{"ok":true}}\n\n'],
    new Promise(() => {}),
  );
  await withFetch(client, async () => {
    assert.deepEqual(await requestService(client, 'p1', 's1', {}, 60000), { ok: true });
  });
});
