import { describe, it, expect, vi } from 'vitest';
import { WriteQueue } from './WriteQueue.js';

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

  it('skips what is queued behind a refusal, and what is queued while its refetch runs', async () => {
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
    expect(await b).toBe(false);
    expect(await late).toBe(false);
    expect(sent).toEqual([]);
    // What comes after is sent again.
    expect(await q.push(async () => sent.push('after'))).toBe(true);
    expect(sent).toEqual(['after']);
  });

  it('skips behind a refusal even when its refetch fails too', async () => {
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
    expect(await b).toBe(false);
    expect(sent).toEqual([]);
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
