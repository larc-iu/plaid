// A request the server answers 404 for (its service channel dropped and the
// server ended it, or the server restarted) is not a stop anybody asked for:
// the next checkpoint throws ServiceRequestGone, a ServiceCancelled that says
// so, and nothing more is reported for it. A stop the requester asked for is
// still reported as stopped. Mirrors the Python client's tests in
// plaid-client-py/tests/test_service.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serve, ServiceCancelled, ServiceRequestGone, INSTANCE_ID } from '../src/services.js';

const INFO = { serviceId: 'test:echo', serviceName: 'Echo', description: 'x' };

// A client whose report of request `lost` is answered 404, every report kept.
const fakeClient = (sent, holder) => ({
  baseUrl: 'http://plaid.test',
  messages: {
    listen: (_projectId, onEvent) => {
      holder.onEvent = onEvent;
      return { readyState: 1, close() {} };
    },
  },
  _request: async (_method, path, { body }) => {
    const id = decodeURIComponent(path.split('/service-requests/')[1].split('/')[0]);
    sent.push({ id, status: body.status, data: body.data });
    if (id === 'lost') throw Object.assign(new Error('HTTP 404'), { status: 404 });
    return {};
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a 404 on a progress report ends the work as gone, not as a stop', async () => {
  const sent = [];
  const holder = {};
  const helpers = {};
  const reg = serve(fakeClient(sent, holder), 'p1', INFO, (_data, helper) => {
    helpers[helper.requestId] = helper;
  });
  try {
    holder.onEvent('service_request', { requestId: 'lost', data: {} });
    holder.onEvent('service_request', { requestId: 'asked', data: {} });
    await helpers.lost.progress(10, 'Writing');
    holder.onEvent('service_cancel', { requestId: 'asked' });
    assert.equal(helpers.lost.gone, true);
    assert.equal(helpers.lost.cancelled, true, 'a handler that polls cancelled stops too');
    assert.equal(helpers.asked.gone, false);
    assert.equal(helpers.asked.cancelled, true);
    assert.throws(
      () => helpers.lost.raiseIfCancelled(),
      (e) => e instanceof ServiceRequestGone && e instanceof ServiceCancelled,
    );
    assert.throws(
      () => helpers.asked.raiseIfCancelled(),
      (e) => e instanceof ServiceCancelled && !(e instanceof ServiceRequestGone),
    );
  } finally {
    reg.stop();
  }
});

test('a handler ending on a lost request reports nothing, a stop asked for is reported', async () => {
  const sent = [];
  const holder = {};
  const reg = serve(fakeClient(sent, holder), 'p1', INFO, async (_data, helper) => {
    if (helper.requestId === 'asked') holder.onEvent('service_cancel', { requestId: 'asked' });
    await helper.progress(10, 'Working');
    await helper.progress(20, 'Working');
  });
  try {
    holder.onEvent('service_request', { requestId: 'lost', data: {} });
    holder.onEvent('service_request', { requestId: 'asked', data: {} });
    await flush();
    await flush();
    assert.deepEqual(
      sent.filter((s) => s.id === 'lost').map((s) => s.status),
      ['progress'],
      'one progress refused 404, then nothing',
    );
    assert.deepEqual(
      sent.filter((s) => s.id === 'asked'),
      [{ id: 'asked', status: 'completed', data: { stopped: true } }],
    );
  } finally {
    reg.stop();
  }
});

test('a channel names its process, the same on every project', () => {
  const paths = [];
  const client = {
    baseUrl: 'http://plaid.test',
    messages: {
      listen: (_p, _on, path) => {
        paths.push(path);
        return { readyState: 1, close() {} };
      },
    },
  };
  const regs = ['p1', 'p2'].map((p) => serve(client, p, INFO, () => {}));
  try {
    const ids = paths.map((p) => new URL(p, 'http://x').searchParams.get('instance-id'));
    assert.deepEqual(ids, [INSTANCE_ID, INSTANCE_ID]);
    assert.ok(INSTANCE_ID.length >= 32);
  } finally {
    regs.forEach((r) => r.stop());
  }
});

test('a stop asked for wins over a lost request', async () => {
  const sent = [];
  const holder = {};
  const helpers = {};
  const reg = serve(fakeClient(sent, holder), 'p1', INFO, (_data, helper) => {
    helpers[helper.requestId] = helper;
  });
  try {
    holder.onEvent('service_request', { requestId: 'lost', data: {} });
    holder.onEvent('service_cancel', { requestId: 'lost' });
    await helpers.lost.critical(() => helpers.lost.progress(10, 'Writing'));
    assert.equal(helpers.lost.gone, false);
    assert.throws(
      () => helpers.lost.raiseIfCancelled(),
      (e) => e instanceof ServiceCancelled && !(e instanceof ServiceRequestGone),
    );
  } finally {
    reg.stop();
  }
});
