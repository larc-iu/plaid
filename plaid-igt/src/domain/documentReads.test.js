import { describe, it, expect } from 'vitest';
import { READS_IN_FLIGHT, readAll, readInOrder, readLayerIds } from './documentReads.js';
import { buildRawDoc } from './test-helpers.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A reader whose reads settle when the test says so, counting how many are
// outstanding at once.
function heldReads() {
  const held = new Map();
  const started = [];
  let outstanding = 0;
  let most = 0;
  const read = (id) => {
    started.push(id);
    outstanding += 1;
    most = Math.max(most, outstanding);
    return new Promise((resolve, reject) => {
      held.set(id, {
        resolve: (v) => {
          outstanding -= 1;
          resolve(v);
        },
        reject: (e) => {
          outstanding -= 1;
          reject(e);
        },
      });
    });
  };
  return { read, held, started, most: () => most };
}

describe('readInOrder', () => {
  it('yields in the order given, whatever order the reads settle in', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const delays = { a: 30, b: 5, c: 20, d: 0, e: 10, f: 0 };
    const out = [];
    for await (const { id, value } of readInOrder(ids, async (x) => {
      await tick(delays[x]);
      return x.toUpperCase();
    })) {
      out.push([id, value]);
    }
    expect(out).toEqual(ids.map((x) => [x, x.toUpperCase()]));
  });

  it('keeps at most four reads in flight, and no more than four waiting on a slow caller', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `d${i}`);
    const { read, held, started, most } = heldReads();
    const it = readInOrder(ids, read);
    const first = it.next();
    await tick();
    expect(started).toEqual(ids.slice(0, READS_IN_FLIGHT));
    // The caller asked for the first, so its landing frees one place.
    for (const id of started) held.get(id).resolve(id);
    expect((await first).value).toEqual({ id: 'd0', value: 'd0' });
    await tick();
    expect(started).toHaveLength(READS_IN_FLIGHT + 1);
    // The caller is busy: four reads have landed or are on their way, and
    // nothing more starts however long it takes.
    held.get('d4').resolve('d4');
    await tick(5);
    expect(started).toHaveLength(READS_IN_FLIGHT + 1);
    let n = 1;
    for (;;) {
      const pending = it.next();
      await tick();
      for (const id of started) held.get(id)?.resolve(id);
      const { done } = await pending;
      if (done) break;
      n += 1;
    }
    expect(n).toBe(ids.length);
    expect(most()).toBeLessThanOrEqual(READS_IN_FLIGHT);
  });

  it('hands back a failed read in its place and goes on', async () => {
    const out = [];
    for await (const r of readInOrder(['a', 'b', 'c'], async (x) => {
      if (x === 'b') throw new Error('gone');
      return x;
    })) {
      out.push(r.error ? `${r.id}:${r.error.message}` : r.value);
    }
    expect(out).toEqual(['a', 'b:gone', 'c']);
  });

  it('starts no further reads once the caller leaves', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `d${i}`);
    const started = [];
    for await (const { id } of readInOrder(ids, async (x) => {
      started.push(x);
      return x;
    })) {
      if (id === 'd1') break;
    }
    await tick(5);
    expect(started.length).toBeLessThanOrEqual(2 + READS_IN_FLIGHT);
  });
});

describe('readAll', () => {
  it('returns every value in order and reports progress', async () => {
    const progress = [];
    const out = await readAll(['a', 'b', 'c'], async (x) => x + x, {
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    });
    expect(out).toEqual(['aa', 'bb', 'cc']);
    expect(progress).toEqual(['1/3', '2/3', '3/3']);
  });

  it('fails on the first failed read', async () => {
    await expect(
      readAll(['a', 'b', 'c'], async (x) => {
        if (x === 'b') throw new Error('gone');
        return x;
      }),
    ).rejects.toThrow('gone');
  });
});

describe('readLayerIds', () => {
  // A project's layer tree has the same shape as a document's, without data.
  const project = () => {
    const p = buildRawDoc();
    // Another app's token layer on the baseline, with a field of its own on
    // the words, and another text layer with a token layer of its own.
    const [tl] = p.textLayers;
    tl.tokenLayers.push({ id: 'udL', config: {}, spanLayers: [] });
    tl.tokenLayers[1].spanLayers.push({ id: 'lemmaL', name: 'Lemma', config: {} });
    p.textLayers.push({
      id: 'tl-2',
      config: {},
      tokenLayers: [{ id: 'otherL', config: {}, spanLayers: [] }],
    });
    return p;
  };
  const sorted = (ids) => [...ids].sort();

  it("names this app's layers and every field of it by default", () => {
    expect(sorted(readLayerIds(project()))).toEqual(
      sorted(['tl-1', 'sentL', 'wordL', 'morphL', 'alignL', 'wsl-0', 'msl-0', 'ssl-0']),
    );
  });

  it('names no field, or the ones asked for', () => {
    expect(sorted(readLayerIds(project(), { spans: [] }))).toEqual(
      sorted(['tl-1', 'sentL', 'wordL', 'morphL', 'alignL']),
    );
    expect(sorted(readLayerIds(project(), { spans: ['msl-0'] }))).toEqual(
      sorted(['tl-1', 'sentL', 'wordL', 'morphL', 'alignL', 'msl-0']),
    );
  });

  it('names every token layer of every text layer when asked for all', () => {
    expect(sorted(readLayerIds(project(), { tokenLayers: 'all', spans: [] }))).toEqual(
      sorted(['tl-1', 'sentL', 'wordL', 'morphL', 'alignL', 'udL', 'otherL']),
    );
  });

  it('is null for a project with no baseline, which reads everything', () => {
    expect(readLayerIds({ textLayers: [{ id: 'x', config: {}, tokenLayers: [] }] })).toBeNull();
    expect(readLayerIds(null)).toBeNull();
  });
});
