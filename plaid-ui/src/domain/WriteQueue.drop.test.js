import { describe, it, expect, vi, afterEach } from 'vitest';
import { WriteQueue } from './WriteQueue.js';

// A send pushed with a `signal` is dropped once the signal is aborted (an
// upload the person cancelled): never sent again, no refusal, no error, and
// the sends behind it still go. One that had started may have landed, so the
// screen is refetched once the queue has drained.

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const offline = () => Object.assign(new Error('Network error: Failed to fetch'), { status: 0 });
const aborted = () => new DOMException('This operation was aborted', 'AbortError');

afterEach(() => vi.useRealTimers());

const queue = () => {
  const reloadDrained = vi.fn(async () => {});
  const q = new WriteQueue({ reloadDrained, retryDelay: () => 60000 });
  return { q, reloadDrained };
};
const options = (signal, refused, resync) => ({
  signal,
  refused,
  resync,
  resendWhenBack: (err) => err.status === 0,
});

describe('a send dropped by its signal', () => {
  it('is never sent when aborted before its turn, and refetches nothing', async () => {
    const { q, reloadDrained } = queue();
    const ahead = deferred();
    const sent = [];
    const refused = vi.fn();
    const abort = new AbortController();
    const first = q.push(async () => {
      sent.push('ahead');
      await ahead.promise;
    });
    const upload = q.push(async () => sent.push('upload'), options(abort.signal, refused));
    const behind = q.push(async () => sent.push('behind'));
    await flush();
    abort.abort();
    ahead.resolve();
    expect(await first).toBe(true);
    expect(await upload).toBe(false);
    expect(await behind).toBe(true);
    expect(sent).toEqual(['ahead', 'behind']);
    expect(refused).not.toHaveBeenCalled();
    expect(reloadDrained).not.toHaveBeenCalled();
    expect(q.isSaving).toBe(false);
  });

  it('stops while its first send is going, is not refused, and refetches once the writes behind it land', async () => {
    const { q, reloadDrained } = queue();
    const going = deferred();
    const sent = [];
    const refused = vi.fn();
    const resync = vi.fn(async () => {});
    const abort = new AbortController();
    let tries = 0;
    const upload = q.push(
      async () => {
        tries += 1;
        await going.promise;
      },
      options(abort.signal, refused, resync),
    );
    const behind = q.push(async () => sent.push('behind'));
    await flush();
    abort.abort();
    going.reject(aborted());
    expect(await upload).toBe(false);
    expect(await behind).toBe(true);
    expect(tries).toBe(1);
    expect(sent).toEqual(['behind']);
    expect(refused).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
    expect(reloadDrained).toHaveBeenCalledTimes(1);
    expect(q.isSaving).toBe(false);
  });

  it('stops a resend that waits for the network at once, and never sends it again', async () => {
    const { q, reloadDrained } = queue();
    const refused = vi.fn();
    const abort = new AbortController();
    let tries = 0;
    const upload = q.push(
      async () => {
        tries += 1;
        throw offline();
      },
      options(abort.signal, refused),
    );
    await flush();
    expect(q.isOffline).toBe(true);
    abort.abort();
    // The wait was a minute, so this lands only if the abort ended it.
    expect(await upload).toBe(false);
    expect(tries).toBe(1);
    expect(q.isOffline).toBe(false);
    expect(refused).not.toHaveBeenCalled();
    expect(reloadDrained).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(tries).toBe(1);
  });

  it('stops a resend that is running, whatever it then fails with', async () => {
    const { q, reloadDrained } = queue();
    const second = deferred();
    const refused = vi.fn();
    const abort = new AbortController();
    let tries = 0;
    const upload = q.push(
      async () => {
        tries += 1;
        if (tries === 1) throw offline();
        await second.promise;
      },
      options(abort.signal, refused),
    );
    await flush();
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(tries).toBe(2);
    abort.abort();
    // A lost answer, which would otherwise be sent again.
    second.reject(offline());
    expect(await upload).toBe(false);
    expect(tries).toBe(2);
    expect(refused).not.toHaveBeenCalled();
    expect(reloadDrained).toHaveBeenCalledTimes(1);
  });

  it('lands as any send does when it was answered before the abort', async () => {
    const { q, reloadDrained } = queue();
    const abort = new AbortController();
    const upload = q.push(async () => {
      abort.abort();
    }, options(abort.signal));
    expect(await upload).toBe(true);
    expect(reloadDrained).not.toHaveBeenCalled();
  });

  it('refetches through its resync when the queue has no reloadDrained', async () => {
    const q = new WriteQueue({ retryDelay: () => 60000 });
    const resync = vi.fn(async () => {});
    const abort = new AbortController();
    const upload = q.push(
      async () => {
        abort.abort();
        throw aborted();
      },
      options(abort.signal, null, resync),
    );
    expect(await upload).toBe(false);
    await flush();
    expect(resync).toHaveBeenCalledTimes(1);
  });
});
