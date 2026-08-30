// A service must survive the server restarting under it: the registration
// reopens its own channel and only claims to be connected once the server has
// actually answered. Mirrors the Python client's tests in
// plaid-client-py/tests/test_service.py.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { serve } from '../src/services.js';

/** Stand-in for an SSE connection: `readyState` is what the caller observes. */
function fakeConnection(readyState) {
  return { readyState, closed: false, close() { this.closed = true; this.readyState = 2; } };
}

function fakeClient(openChannel) {
  return {
    baseUrl: 'http://plaid.test',
    messages: { listen: openChannel },
    _request: async () => ({}),
  };
}

const INFO = { serviceId: 'test:echo', serviceName: 'Echo', description: 'x' };

test('a dropped channel is reopened, and only a channel the server answered counts as connected', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const events = [];
    // The server is down for two attempts, then back.
    const outcomes = [fakeConnection(2), fakeConnection(2), fakeConnection(1)];
    const opened = [];
    const client = fakeClient(() => {
      const conn = outcomes[Math.min(opened.length, outcomes.length - 1)];
      opened.push(conn);
      return conn;
    });

    const reg = serve(client, 'p1', INFO, () => {}, {}, (event) => events.push(event));
    assert.equal(opened.length, 1, 'the initial registration opens the channel');
    assert.equal(reg.isConnected(), false, 'the first attempt found the server down');

    mock.timers.tick(3000);   // attempt 2: still down
    mock.timers.tick(3000);   // attempt 3: server back, channel OPEN
    mock.timers.tick(3000);   // the tick that observes it open
    assert.ok(opened.length >= 3, 'kept retrying while the server was away');
    assert.equal(reg.isConnected(), true);
    assert.deepEqual(events, ['registered'], 'reported once, and only when really open');

    reg.stop();
  } finally {
    mock.timers.reset();
  }
});

test('an outage reports one disconnect and one reconnect, however many retries it took', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const events = [];
    const live = fakeConnection(1);
    const down = fakeConnection(2);
    const back = fakeConnection(1);
    const queue = [down, down, back];
    let opens = 0;
    const client = fakeClient(() => (opens === 0 ? (opens++, live) : queue[Math.min(opens++ - 1, 2)]));

    const reg = serve(client, 'p1', INFO, () => {}, {}, (event) => events.push(event));
    mock.timers.tick(3000);
    assert.deepEqual(events, ['registered']);

    live.readyState = 2;                    // the server went away
    mock.timers.tick(3000);                 // notices, reopens (still down)
    mock.timers.tick(3000);                 // still down
    mock.timers.tick(3000);                 // back up
    mock.timers.tick(3000);                 // observes it open
    assert.deepEqual(events, ['registered', 'disconnected', 'reconnected']);
    assert.equal(reg.isRunning(), true, 'an outage never ends the registration');

    reg.stop();
    assert.equal(reg.isRunning(), false);
    assert.equal(reg.isConnected(), false);
  } finally {
    mock.timers.reset();
  }
});
