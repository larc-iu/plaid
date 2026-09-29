import { describe, it, expect, vi } from 'vitest';
import { WriteQueue } from './WriteQueue.js';
import { humanizeError } from '../lib/errors.js';

// The one queue behind DocumentModel and the igt vocabulary screens. Each case
// is one of the rules the document queue learned on 2026-09-23 (863cb8e9,
// 23212ef9, cf272f08, 26d99691), held here for every screen that queues.

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
// What the client throws when the server cannot be reached.
const offline = () => Object.assign(new Error('Network error: Failed to fetch'), { status: 0 });
const boom500 = () => Object.assign(new Error('HTTP 500 boom'), { status: 500 });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('WriteQueue', () => {
  it('sends one at a time, in the order the writes were made', async () => {
    const q = new WriteQueue();
    const sent = [];
    const first = deferred();
    q.push(async () => {
      sent.push('a');
      await first.promise;
    });
    const b = q.push(async () => sent.push('b'));
    await flush();
    expect(sent).toEqual(['a']);
    first.resolve();
    expect(await b).toBe(true);
    expect(sent).toEqual(['a', 'b']);
  });

  it('sends what is queued behind a refusal, and what is queued while its refetch runs', async () => {
    const q = new WriteQueue();
    const sent = [];
    const refetch = deferred();
    let late;
    const a = q.push(
      async () => {
        throw new Error('refused');
      },
      {
        refused: async () => {
          late = q.push(async () => sent.push('late'));
          await refetch.promise;
        },
      },
    );
    const b = q.push(async () => sent.push('b'));
    await flush();
    refetch.resolve();
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(await late).toBe(true);
    expect(sent).toEqual(['b', 'late']);
  });

  it('sends what is queued behind a refusal even when its refetch fails too', async () => {
    const q = new WriteQueue();
    const sent = [];
    const a = q.push(
      async () => {
        throw new Error('refused');
      },
      {
        refused: async () => {
          throw new Error('offline');
        },
      },
    );
    const b = q.push(async () => sent.push('b'));
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(sent).toEqual(['b']);
  });

  it('tries a failed resync again until it lands, saving all the while', async () => {
    const q = new WriteQueue({ retryDelay: () => 20 });
    let fails = 3;
    const resync = vi.fn(async () => {
      if (fails-- > 0) throw offline();
    });
    const a = q.push(
      async () => {
        throw new Error('refused');
      },
      { refused: async () => {}, resync },
    );
    const b = q.push(async () => {});
    await flush();
    expect(q.isSaving).toBe(true);
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    // Once b has landed, the screen is refetched again to show it.
    await q.whenIdle();
    expect(resync).toHaveBeenCalledTimes(5);
    expect(q.isSaving).toBe(false);
  });

  it('stops retrying a resync that no retry can mend', async () => {
    const q = new WriteQueue({ retryDelay: () => 0 });
    const resync = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 403'), { status: 403 });
    });
    const a = q.push(
      async () => {
        throw new Error('refused');
      },
      { resync },
    );
    expect(await a).toBe(false);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(q.isSaving).toBe(false);
  });

  it('refetches again once the sends behind a refusal have landed, saving all the while', async () => {
    const q = new WriteQueue();
    const refetch = deferred();
    const server = [];
    const shows = [];
    const resync = vi.fn(async () => {
      if (resync.mock.calls.length === 1) await refetch.promise;
      shows.push([q.isSaving, ...server]);
    });
    let late;
    const a = q.push(
      async () => {
        throw new Error('refused');
      },
      {
        resync: async () => {
          if (!late) late = q.push(async () => server.push('late'), { resync });
          await resync();
        },
      },
    );
    const b = q.push(async () => server.push('b'), { resync });
    const copy = q.push(async () => server.push('copy'), { shown: false });
    await flush();
    refetch.resolve();
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(await copy).toBe(true);
    expect(await late).toBe(true);
    await q.whenIdle();
    // The refusal's own refetch, then one that shows what was sent behind it,
    // both while the queue is still saving.
    expect(shows).toEqual([[true], [true, 'b', 'copy', 'late']]);
    expect(q.isSaving).toBe(false);
  });

  it('refetches nothing more after a refusal with nothing behind it', async () => {
    const q = new WriteQueue();
    const resync = vi.fn(async () => {});
    await q.push(
      async () => {
        throw new Error('refused');
      },
      { resync },
    );
    await q.whenIdle();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('refetches once for two refusals in a row, the later one standing in for the earlier', async () => {
    const q = new WriteQueue();
    const resync = vi.fn(async () => {});
    const refuse = async () => {
      throw new Error('refused');
    };
    const a = q.push(refuse, { resync });
    const b = q.push(refuse, { resync });
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    await q.whenIdle();
    expect(resync).toHaveBeenCalledTimes(2);
  });

  it('refetches through its own reloadDrained once the sends behind a refusal have landed', async () => {
    const reloadDrained = vi.fn(async () => {});
    const q = new WriteQueue({ reloadDrained });
    const resync = vi.fn(async () => {});
    const a = q.push(
      async () => {
        throw new Error('refused');
      },
      { resync },
    );
    const b = q.push(async () => {}, { resync });
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    await q.whenIdle();
    expect(resync).toHaveBeenCalledTimes(1);
    expect(reloadDrained).toHaveBeenCalledTimes(1);
  });

  it('is offline while a refetch waits for the server, and says so to whoever watches', async () => {
    const offlineSeen = [];
    const q = new WriteQueue({
      retryDelay: () => 10,
      onOfflineChange: (o) => offlineSeen.push(o),
    });
    const watched = [];
    q.subscribe(() => watched.push(q.isOffline));
    let down = true;
    const resync = vi.fn(async () => {
      if (down) throw offline();
    });
    const a = q.push(
      async () => {
        throw offline();
      },
      { resync },
    );
    await flush();
    expect(q.isOffline).toBe(true);
    expect(q.isSaving).toBe(true);
    // Editing goes on while offline: the edit is queued and sent once back.
    const b = q.push(async () => {}, { resync });
    down = false;
    expect(await a).toBe(false);
    expect(q.isOffline).toBe(false);
    expect(await b).toBe(true);
    await q.whenIdle();
    expect(offlineSeen).toEqual([true, false]);
    expect(watched).toContain(true);
    expect(q.isOffline).toBe(false);
  });

  it('is not offline while a refetch fails for a reason of the server', async () => {
    const q = new WriteQueue({ retryDelay: () => 0 });
    const seen = [];
    const resync = vi.fn(async () => {
      seen.push(q.isOffline);
      if (resync.mock.calls.length < 3) throw boom500();
    });
    await q.push(
      async () => {
        throw boom500();
      },
      { resync },
    );
    expect(seen).toEqual([false, false, false]);
    expect(q.isOffline).toBe(false);
  });

  it('is no longer offline once let go', async () => {
    const q = new WriteQueue({ retryDelay: () => 60000 });
    const a = q.push(
      async () => {
        throw offline();
      },
      {
        resync: async () => {
          throw offline();
        },
      },
    );
    await flush();
    expect(q.isOffline).toBe(true);
    q.letGo();
    await a;
    expect(q.isOffline).toBe(false);
  });

  it('sends a write that showed nothing past a refusal ahead of it, and skips nothing for its own', async () => {
    const q = new WriteQueue();
    const sent = [];
    const refused = vi.fn(async () => {});
    q.push(
      async () => {
        throw new Error('refused');
      },
      { refused },
    );
    const copy = q.push(async () => sent.push('copy'), { shown: false });
    expect(await copy).toBe(true);
    const failedCopy = q.push(
      async () => {
        throw new Error('no');
      },
      { shown: false, refused },
    );
    const after = q.push(async () => sent.push('after'));
    expect(await failedCopy).toBe(false);
    expect(await after).toBe(true);
    expect(sent).toEqual(['copy', 'after']);
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it('reads from outside only once the queue has drained, and again when a write is made meanwhile', async () => {
    const q = new WriteQueue();
    const server = { value: 'old' };
    const held = deferred();
    q.push(async () => {
      await held.promise;
      server.value = 'first';
    });
    let reads = 0;
    const read = q.readWhenIdle(async () => {
      reads += 1;
      // A write made while the first read is on the wire.
      if (reads === 1) q.push(async () => (server.value = 'second'));
      return server.value;
    });
    await flush();
    expect(reads).toBe(0);
    held.resolve();
    expect(await read).toBe('second');
    expect(reads).toBe(2);
  });

  it('refetches once drained when a send asked for the server view, inside isSaving', async () => {
    const saving = [];
    let q;
    const reloadDrained = vi.fn(async () => {
      saving.push(q.isSaving);
    });
    q = new WriteQueue({ reloadDrained, onSavingChange: (s) => saving.push(s) });
    const held = deferred();
    q.push(async () => {
      q.reloadWhenDrained = true;
    });
    q.push(async () => held.promise);
    await flush();
    expect(reloadDrained).not.toHaveBeenCalled();
    held.resolve();
    await q.whenIdle();
    expect(reloadDrained).toHaveBeenCalledTimes(1);
    expect(saving).toEqual([true, true, false]);
  });

  it('tries a failed refetch once drained again until it lands', async () => {
    let fails = 2;
    const reloadDrained = vi.fn(async () => {
      if (fails-- > 0) throw offline();
    });
    const q = new WriteQueue({ reloadDrained, retryDelay: () => 0 });
    await q.push(async () => {
      q.reloadWhenDrained = true;
    });
    await q.whenIdle();
    expect(reloadDrained).toHaveBeenCalledTimes(3);
  });

  it('keeps retrying a resync while the server cannot be reached, however long that is', async () => {
    const outOfStep = vi.fn();
    const q = new WriteQueue({ retryDelay: () => 0, onOutOfStep: outOfStep });
    let fails = 9;
    const resync = vi.fn(async () => {
      if (fails-- > 0) throw offline();
    });
    const a = q.push(
      async () => {
        throw offline();
      },
      { resync },
    );
    expect(await a).toBe(false);
    expect(resync).toHaveBeenCalledTimes(10);
    expect(outOfStep).not.toHaveBeenCalled();
  });

  it('gives up on a resync the server keeps failing, says the screen is out of step once, and still sends what is behind', async () => {
    const outOfStep = vi.fn();
    const q = new WriteQueue({ retryDelay: () => 0, onOutOfStep: outOfStep });
    const boom = Object.assign(new Error('HTTP 500 boom'), { status: 500 });
    const resync = vi.fn(async () => {
      throw boom;
    });
    const a = q.push(
      async () => {
        throw new Error('refused');
      },
      { resync },
    );
    const b = q.push(async () => {});
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    await q.whenIdle();
    // Four tries after the refusal, four more once b has landed.
    expect(resync).toHaveBeenCalledTimes(8);
    expect(outOfStep).toHaveBeenCalledTimes(1);
    expect(outOfStep).toHaveBeenCalledWith(boom);
    expect(q.isSaving).toBe(false);
    expect(q.outOfStep).toBe(true);
  });

  it('is out of step only from a refetch given up until one lands', async () => {
    const q = new WriteQueue({ retryDelay: () => 0 });
    let fail = true;
    const resync = async () => {
      if (fail) throw Object.assign(new Error('HTTP 500 boom'), { status: 500 });
    };
    const refused = async () => {
      throw new Error('refused');
    };
    expect(q.outOfStep).toBe(false);
    await q.push(refused, { resync });
    expect(q.outOfStep).toBe(true);
    fail = false;
    await q.push(refused, { resync });
    expect(q.outOfStep).toBe(false);
  });

  // The queue waits out exactly what every error toast calls "Could not reach
  // the server" (lib/errors.js), so the two can never disagree about which
  // failure is the network's. A status the client left only in the message is
  // read the same way in both places.
  it.each([
    [
      'a status only in the message',
      () => new Error('HTTP 503 Service Unavailable at http://x/api'),
    ],
    ['a gateway timeout', () => Object.assign(new Error('HTTP 504'), { status: 504 })],
    ['a request that timed out', () => new Error('Request timed out at http://x/api')],
  ])('keeps retrying %s, which a toast calls the network', async (_, fail) => {
    expect(humanizeError(fail())).toMatch(/Failed to reach the server/);
    const outOfStep = vi.fn();
    const q = new WriteQueue({ retryDelay: () => 0, onOutOfStep: outOfStep });
    let fails = 6;
    const resync = vi.fn(async () => {
      if (fails-- > 0) throw fail();
    });
    await q.push(
      async () => {
        throw new Error('refused');
      },
      { resync },
    );
    expect(resync).toHaveBeenCalledTimes(7);
    expect(outOfStep).not.toHaveBeenCalled();
  });

  it('stops at once on a refusal no retry can mend, whether its status is a field or only in the message', async () => {
    for (const fail of [
      () => Object.assign(new Error('HTTP 404 gone'), { status: 404 }),
      () => new Error('HTTP 403 Forbidden at http://x/api'),
    ]) {
      const outOfStep = vi.fn();
      const q = new WriteQueue({ retryDelay: () => 0, onOutOfStep: outOfStep });
      const resync = vi.fn(async () => {
        throw fail();
      });
      await q.push(
        async () => {
          throw new Error('refused');
        },
        { resync },
      );
      expect(resync).toHaveBeenCalledTimes(1);
      expect(outOfStep).not.toHaveBeenCalled();
    }
  });

  it('counts only the server’s own failures against the tries, not the time the network was down', async () => {
    const outOfStep = vi.fn();
    const q = new WriteQueue({ retryDelay: () => 0, onOutOfStep: outOfStep });
    // Down for a while, then one error while the server comes back up.
    const answers = [offline, offline, offline, offline, offline, () => boom500()];
    const resync = vi.fn(async () => {
      const next = answers.shift();
      if (next) throw next();
    });
    await q.push(
      async () => {
        throw new Error('refused');
      },
      { resync },
    );
    expect(resync).toHaveBeenCalledTimes(7);
    expect(outOfStep).not.toHaveBeenCalled();
  });

  it('gives up on a resync that fails with a bug of its own', async () => {
    const outOfStep = vi.fn();
    const q = new WriteQueue({ retryDelay: () => 0, onOutOfStep: outOfStep });
    const resync = vi.fn(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'layers')");
    });
    const a = q.push(
      async () => {
        throw new Error('refused');
      },
      { resync },
    );
    expect(await a).toBe(false);
    expect(resync).toHaveBeenCalledTimes(4);
    expect(outOfStep).toHaveBeenCalledTimes(1);
  });

  it('gives up on a refetch once drained that the server keeps failing', async () => {
    const outOfStep = vi.fn();
    const reloadDrained = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 500 boom'), { status: 500 });
    });
    const q = new WriteQueue({ reloadDrained, retryDelay: () => 0, onOutOfStep: outOfStep });
    await q.push(async () => {
      q.reloadWhenDrained = true;
    });
    await q.whenIdle();
    expect(reloadDrained).toHaveBeenCalledTimes(4);
    expect(outOfStep).toHaveBeenCalledTimes(1);
    expect(q.isSaving).toBe(false);
  });

  it('stops retrying a resync once let go, and still sends what it was holding', async () => {
    const q = new WriteQueue({ retryDelay: () => 60000 });
    const resync = vi.fn(async () => {
      throw offline();
    });
    const a = q.push(
      async () => {
        throw offline();
      },
      { resync },
    );
    const b = q.push(async () => {});
    await flush();
    expect(q.isSaving).toBe(true);
    q.letGo();
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(q.isSaving).toBe(false);
    // Held again, the queue says a refetch was left undone.
    expect(q.hold()).toBe(true);
    expect(q.hold()).toBe(false);
  });

  it('once let go, still sends what is queued and does not refetch for a screen that is gone', async () => {
    const reloadDrained = vi.fn(async () => {});
    const q = new WriteQueue({ reloadDrained });
    const resync = vi.fn(async () => {});
    const sent = [];
    const held = deferred();
    const a = q.push(async () => {
      await held.promise;
      sent.push('a');
      q.reloadWhenDrained = true;
    });
    const b = q.push(
      async () => {
        throw new Error('refused');
      },
      { resync },
    );
    q.letGo();
    held.resolve();
    expect(await a).toBe(true);
    expect(await b).toBe(false);
    await q.whenIdle();
    expect(sent).toEqual(['a']);
    expect(resync).not.toHaveBeenCalled();
    expect(reloadDrained).not.toHaveBeenCalled();
    expect(q.hold()).toBe(true);
  });

  it('is watched the way useSavingGuard watches a document', async () => {
    const q = new WriteQueue();
    const seen = [];
    const off = q.subscribe(() => seen.push(q.isSaving));
    const held = deferred();
    q.push(async () => held.promise);
    q.push(async () => {});
    expect(q.isSaving).toBe(true);
    held.resolve();
    await q.whenIdle();
    off();
    expect(seen).toEqual([true, false]);
  });
});
