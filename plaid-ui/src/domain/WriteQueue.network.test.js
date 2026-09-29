import { describe, it, expect, vi, afterEach } from 'vitest';
import { WriteQueue } from './WriteQueue.js';

// What the queue does when the network goes, and when the page does (V5, H5-4
// and H5-7).

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const offline = () =>
  Object.assign(new Error('Network error: Failed to fetch'), { status: 0, offline: true });

afterEach(() => {
  window.dispatchEvent(new Event('pageshow'));
});

describe('a send that never left the browser', () => {
  it('goes again once the network is back, instead of being refused', async () => {
    const q = new WriteQueue({ retryDelay: () => 60000 });
    const sent = [];
    const refused = vi.fn();
    let tries = 0;
    const a = q.push(
      async () => {
        tries += 1;
        if (tries === 1) throw offline();
        sent.push('a');
      },
      { refused, resync: async () => {}, resendWhenBack: (err) => err.offline === true },
    );
    const b = q.push(async () => sent.push('b'));
    await flush();
    expect(q.isOffline).toBe(true);
    expect(q.isSaving).toBe(true);
    expect(sent).toEqual([]);
    window.dispatchEvent(new Event('online'));
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(sent).toEqual(['a', 'b']);
    expect(refused).not.toHaveBeenCalled();
    expect(q.isOffline).toBe(false);
  });

  it('is refused as before when the caller does not allow a resend', async () => {
    const q = new WriteQueue({ retryDelay: () => 0 });
    const refused = vi.fn();
    const a = q.push(
      async () => {
        throw offline();
      },
      { refused, resync: async () => {}, resendWhenBack: () => false },
    );
    expect(await a).toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('is refused when the resend fails some other way', async () => {
    const q = new WriteQueue({ retryDelay: () => 0 });
    const refused = vi.fn();
    let tries = 0;
    const a = q.push(
      async () => {
        tries += 1;
        if (tries === 1) throw offline();
        throw Object.assign(new Error('HTTP 409 changed'), { status: 409 });
      },
      { refused, resync: async () => {}, resendWhenBack: (err) => err.offline === true },
    );
    expect(await a).toBe(false);
    expect(tries).toBe(2);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused.mock.calls[0][0].status).toBe(409);
    expect(q.isOffline).toBe(false);
  });
});

// F-REPAIR's note: the wait for the network did not end when the queue was
// let go, so a send waited out its timer (a minute and more) for a screen
// that had closed, and the close-tab question stayed on meanwhile.
describe('a send waiting for the network when the screen goes', () => {
  it('is tried once more at once, and refused if it fails again', async () => {
    const q = new WriteQueue({ retryDelay: () => 600000 });
    const refused = vi.fn();
    let tries = 0;
    const a = q.push(
      async () => {
        tries += 1;
        throw offline();
      },
      { refused, resync: async () => {}, resendWhenBack: (err) => err.offline === true },
    );
    await flush();
    expect(q.isOffline).toBe(true);
    q.letGo();
    expect(await a).toBe(false);
    expect(tries).toBe(2);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(q.isSaving).toBe(false);
    expect(q.isOffline).toBe(false);
  });

  it('lands when the network is back by then', async () => {
    const q = new WriteQueue({ retryDelay: () => 600000 });
    let tries = 0;
    const a = q.push(
      async () => {
        tries += 1;
        if (tries === 1) throw offline();
      },
      { resync: async () => {}, resendWhenBack: (err) => err.offline === true },
    );
    await flush();
    q.letGo();
    expect(await a).toBe(true);
  });
});

describe('leaving the page', () => {
  it('starts no send once the page is being unloaded', async () => {
    const q = new WriteQueue();
    const sent = [];
    const first = deferred();
    q.push(async () => {
      sent.push('a');
      await first.promise;
    });
    const b = q.push(async () => sent.push('b'));
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    first.resolve();
    await flush();
    expect(sent).toEqual(['a']);
    // Brought back from the back-forward cache, it sends on.
    window.dispatchEvent(new Event('pageshow'));
    expect(await b).toBe(true);
    expect(sent).toEqual(['a', 'b']);
  });
});
