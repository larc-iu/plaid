// A service request outlives the connection that submitted it. The client can
// mint the request id, learn it from the `accepted` event, rejoin the request
// later, and ask the service to stop it. The service side sees who asked and
// whether a stop was requested.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  requestService,
  attachServiceRequest,
  cancelServiceRequest,
  serve,
  ServiceCancelled,
} from '../src/services.js';

/** An SSE body that emits `events`, then blocks until `hold` resolves. */
function fakeClient(events, hold, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const queue = events.slice();
  return {
    baseUrl: 'http://plaid.test',
    token: 't',
    fetchCalls: [],
    async _fetch(url, opts) {
      this.fetchCalls.push({ url, opts });
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 404 ? 'Not Found' : 'OK',
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

test('the accepted event hands the request id to onAccepted, and a minted id rides the URL', async () => {
  const client = fakeClient(
    [
      'event: accepted\ndata: {"request-id":"11111111-1111-4111-8111-111111111111"}\n\n',
      'event: result\ndata: {"data":{"ok":true}}\n\n',
    ],
    new Promise(() => {}),
  );
  const accepted = [];
  await withFetch(client, async () => {
    const value = await requestService(client, 'p1', 's1', { a: 1 }, 60000, undefined, undefined, {
      requestId: '11111111-1111-4111-8111-111111111111',
      onAccepted: (id) => accepted.push(id),
    });
    assert.deepEqual(value, { ok: true });
  });
  assert.deepEqual(accepted, ['11111111-1111-4111-8111-111111111111']);
  assert.match(client.fetchCalls[0].url, /\/services\/s1\/requests\?request-id=11111111-1111-4111-8111-111111111111$/);
  assert.equal(client.fetchCalls[0].opts.method, 'POST');
});

test('attach replays progress and delivers the result over a GET', async () => {
  const client = fakeClient(
    [
      'event: accepted\ndata: {"request-id":"r1"}\n\n',
      'event: progress\ndata: {"progress":{"percent":40,"message":"Reading"}}\n\n',
      'event: result\ndata: {"data":{"kind":"turn"}}\n\n',
    ],
    new Promise(() => {}),
  );
  const progress = [];
  await withFetch(client, async () => {
    const value = await attachServiceRequest(client, 'p1', 'r1', 60000, (p) => progress.push(p));
    assert.deepEqual(value, { kind: 'turn' });
  });
  assert.deepEqual(progress, [{ percent: 40, message: 'Reading' }]);
  assert.match(client.fetchCalls[0].url, /\/projects\/p1\/service-requests\/r1$/);
  assert.equal(client.fetchCalls[0].opts.method, 'GET');
  assert.equal(client.fetchCalls[0].opts.body, undefined, 'a GET carries no body');
});

test('an unknown or expired request rejects with status 404', async () => {
  const client = fakeClient([], new Promise(() => {}), { status: 404 });
  await withFetch(client, async () => {
    await assert.rejects(attachServiceRequest(client, 'p1', 'gone', 60000), (e) => e.status === 404);
  });
});

test('cancel is a DELETE on the request', async () => {
  const calls = [];
  const client = { _request: (method, path) => (calls.push([method, path]), Promise.resolve()) };
  await cancelServiceRequest(client, 'p1', 'r1');
  assert.deepEqual(calls, [['DELETE', '/api/v1/projects/p1/service-requests/r1']]);
});

test('a served request sees who asked and whether a stop was requested', async () => {
  let onEvent;
  const reported = [];
  const client = {
    messages: { listen: (projectId, cb) => ((onEvent = cb), { readyState: 1, close() {} }) },
    _request: (method, path, { body }) => (reported.push({ path, body }), Promise.resolve()),
  };
  const seen = [];
  const registration = serve(client, 'p1', { serviceId: 's1', serviceName: 'S' }, (data, helper) => {
    seen.push({ data, helper });
  });
  try {
    onEvent('service_request', { requestId: 'r1', requesterId: 'u@x.com', data: { q: 1 } });
    const [{ data, helper }] = seen;
    assert.deepEqual(data, { q: 1, requesterId: 'u@x.com' });
    assert.equal(helper.requestId, 'r1');
    assert.equal(helper.requesterId, 'u@x.com');
    assert.equal(helper.cancelled, false);
    await helper.progress(10, 'Writing…', { text: 'Hel' });
    assert.equal(reported[0].path, '/api/v1/projects/p1/service-requests/r1/events');
    assert.deepEqual(reported[0].body, {
      status: 'progress',
      progress: { percent: 10, message: 'Writing…', text: 'Hel' },
    });

    onEvent('service_cancel', { requestId: 'r1' });
    assert.equal(helper.cancelled, true);
    onEvent('service_cancel', { requestId: 'other' }); // unknown ids are ignored

    // progress() is the cancellation checkpoint: once stopped, it throws
    // rather than reporting, which is what makes a service that already
    // reports progress cancellable without any change to the service.
    assert.throws(() => helper.progress(20, 'More…'), ServiceCancelled);
    // …except inside critical(), so a write under way still finishes.
    await helper.critical(async () => {
      await helper.progress(30, 'Committing…');
    });
    assert.deepEqual(reported[1].body, {
      status: 'progress',
      progress: { percent: 30, message: 'Committing…' },
    });

    await helper.complete({ done: true });
    assert.deepEqual(reported[2].body, { status: 'completed', data: { done: true } });
  } finally {
    registration.stop();
  }
});
