// The request deadline is IDLE time, not a cap on the run.
//
// A service that reports its progress is not hung, so every event it sends
// starts the clock again. As a deadline on the whole run, the five-minute
// default killed working transcriptions and handed the document back to the
// user as editable while the service went on writing to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requestService } from '../src/services.js';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An SSE body that emits each of `beats` after that entry's delay, then blocks.
 * `beats` is [{ after, chunk }].
 */
function fakeClient(beats) {
  const encoder = new TextEncoder();
  const queue = beats.slice();
  return {
    baseUrl: 'http://plaid.test',
    token: 't',
    async _fetch() {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            async read() {
              const next = queue.shift();
              if (!next) {
                await new Promise(() => {});
              }
              await sleep(next.after);
              return { done: false, value: encoder.encode(next.chunk) };
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

test('progress restarts the clock, so a run longer than the timeout still finishes', async () => {
  // Four 100ms gaps under a 400ms timeout: 400ms of work, none of it silent.
  const client = fakeClient([
    { after: 100, chunk: sse('progress', { progress: { percent: 25 } }) },
    { after: 100, chunk: sse('progress', { progress: { percent: 50 } }) },
    { after: 100, chunk: sse('progress', { progress: { percent: 75 } }) },
    { after: 100, chunk: sse('result', { data: { ok: true } }) },
  ]);
  await withFetch(client, async () => {
    const result = await requestService(client, 'p1', 's1', {}, 400, undefined);
    assert.deepEqual(result, { ok: true });
  });
});

test('silence longer than the timeout gives up, and says the request is still there', async () => {
  const client = fakeClient([
    { after: 10, chunk: sse('progress', { progress: { percent: 10 } }) },
    { after: 5000, chunk: sse('result', { data: { ok: true } }) },
  ]);
  await withFetch(client, async () => {
    await assert.rejects(
      requestService(client, 'p1', 's1', {}, 150, undefined),
      (e) => /timed out after 150ms of silence/.test(e.message) && e.pending === true,
    );
  });
});

test('a stop leaves the request alive, so the caller keeps its id', async () => {
  const client = fakeClient([]);
  const controller = new AbortController();
  await withFetch(client, async () => {
    const p = requestService(client, 'p1', 's1', {}, 60000, undefined, controller.signal);
    controller.abort();
    await assert.rejects(p, (e) => e.name === 'AbortError' && e.pending === true);
  });
});

test('an error the service reported is the end of it, and is not marked pending', async () => {
  const client = fakeClient([{ after: 5, chunk: sse('error', { error: 'model refused' }) }]);
  await withFetch(client, async () => {
    await assert.rejects(
      requestService(client, 'p1', 's1', {}, 60000, undefined),
      (e) => e.message === 'model refused' && e.pending === undefined,
    );
  });
});

test('no live service is the end of it too', async () => {
  const client = {
    baseUrl: 'http://plaid.test',
    token: 't',
    async _fetch() {
      return { ok: false, status: 503, statusText: 'Service Unavailable' };
    },
  };
  await withFetch(client, async () => {
    await assert.rejects(
      requestService(client, 'p1', 'nope', {}, 60000, undefined),
      (e) => /No live service/.test(e.message) && e.pending === undefined,
    );
  });
});
