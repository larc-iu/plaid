import { describe, it, expect, vi } from 'vitest';
import { loadEntryCounts } from './vocabEntryCounts.js';

const SENSE_PARENT = '01890000-0000-7000-8000-000000000001';

// The cross-project query sees only vocabularies a readable project links. H1-5:
// one no project linked (left behind by a deleted project) read 0 entries while
// it held 2,112, and a person tidying up deletes an "empty" vocabulary.
const clientWith = ({ all, senses, layers = {} }) => ({
  query: vi.fn(async (q) => ({
    results: q.where[0][2].metadata ? senses : all,
  })),
  vocabLayers: {
    get: vi.fn(async (id) => {
      if (!(id in layers)) throw Object.assign(new Error('HTTP 403'), { status: 403 });
      return { id, items: layers[id] };
    }),
  },
});

describe('loadEntryCounts', () => {
  it('counts entries, not senses, for the vocabularies the query sees', async () => {
    const client = clientWith({ all: [['a', 5]], senses: [['a', 2]] });
    expect(await loadEntryCounts(client, ['a'])).toEqual({ a: 3 });
    expect(client.vocabLayers.get).not.toHaveBeenCalled();
  });

  it('reads a vocabulary the query does not see on its own', async () => {
    const client = clientWith({
      all: [['a', 1]],
      senses: [],
      layers: {
        orphan: [
          { id: 'e1', metadata: {} },
          { id: 'e2' },
          { id: 's1', metadata: { parent: SENSE_PARENT } },
        ],
        empty: [],
      },
    });
    expect(await loadEntryCounts(client, ['a', 'orphan', 'empty'])).toEqual({
      a: 1,
      orphan: 2,
      empty: 0,
    });
  });

  it('leaves a count it cannot read unknown, never 0', async () => {
    const client = clientWith({ all: [], senses: [] });
    const counts = await loadEntryCounts(client, ['unreadable']);
    expect(counts.unreadable).toBeUndefined();
  });
});
