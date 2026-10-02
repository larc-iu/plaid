// A service request whose answer went missing (a proxy's 502 or 504, a
// dropped connection) may well have been taken and run. It is not reported
// failed: it is still running, and a request whose id is known is rejoined.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requestService } from '../src/services.js';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const streamOf = (chunks) => {
  const encoder = new TextEncoder();
  const queue = chunks.slice();
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          const next = queue.shift();
          if (!next) return new Promise(() => {});
          return { done: false, value: encoder.encode(next) };
        },
      }),
    },
  };
};

// `answers` maps 'submit' and 'attach' to a list of answers, one per call:
// a status number, an Error to throw, or a list of SSE chunks.
const withServer = async (answers, fn) => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const kind = url.includes('/service-requests/') ? 'attach' : 'submit';
    calls.push(kind);
    const answer = answers[kind].shift();
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return { ok: false, status: answer, statusText: 'Bad Gateway' };
    return streamOf(answer);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
};

const client = { baseUrl: 'http://plaid.test', token: 't' };

for (const status of [502, 504]) {
  test(`a ${status} with no request id is still running, not failed`, async () => {
    await withServer({ submit: [status], attach: [] }, async (calls) => {
      await assert.rejects(
        requestService(client, 'p1', 's1', {}, 60000),
        (e) => e.status === status && e.pending === true,
      );
      assert.deepEqual(calls, ['submit']);
    });
  });
}

test('a 502 on a request whose id is known rejoins it and gets its result', async () => {
  const progress = [];
  await withServer(
    {
      submit: [502],
      attach: [[sse('progress', { progress: { percent: 90 } }), sse('result', { data: { tokens: 355 } })]],
    },
    async (calls) => {
      const result = await requestService(client, 'p1', 's1', {}, 60000, (p) => progress.push(p), undefined, {
        requestId: 'r1',
      });
      assert.deepEqual(result, { tokens: 355 });
      assert.deepEqual(progress, [{ percent: 90 }]);
      assert.deepEqual(calls, ['submit', 'attach']);
    },
  );
});

test('a dropped connection rejoins too, and a rejoin whose answer is lost tries again', async () => {
  await withServer(
    {
      submit: [new TypeError('Failed to fetch')],
      attach: [504, [sse('result', { data: { ok: true } })]],
    },
    async (calls) => {
      const result = await requestService(client, 'p1', 's1', {}, 60000, undefined, undefined, {
        requestId: 'r1',
      });
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(calls, ['submit', 'attach', 'attach']);
    },
  );
});

test('a request the server never had (404 on rejoin) gives the first error, still pending', async () => {
  await withServer({ submit: [502], attach: [404] }, async () => {
    await assert.rejects(
      requestService(client, 'p1', 's1', {}, 60000, undefined, undefined, { requestId: 'r1' }),
      (e) => e.status === 502 && e.pending === true,
    );
  });
});

test('a server error is the end of it: not pending, not rejoined', async () => {
  await withServer({ submit: [500], attach: [] }, async (calls) => {
    await assert.rejects(
      requestService(client, 'p1', 's1', {}, 60000, undefined, undefined, { requestId: 'r1' }),
      (e) => e.status === 500 && e.pending === undefined,
    );
    assert.deepEqual(calls, ['submit']);
  });
});
