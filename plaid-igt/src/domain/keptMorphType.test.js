import { describe, it, expect, vi } from 'vitest';
import { planKeptTypes, queueKeptTypes } from './keptMorphType.js';

// Ruling Q1: the morphemes a delete or an unlink leaves keep the type their
// entry gave them, written where this person can write, one bulk update per
// project.
const set = (value) => [{ op: 'set', path: ['morphType'], value }];

describe('planKeptTypes', () => {
  const client = (rows) => ({
    query: vi.fn(async () => ({ results: rows })),
    tokenLayers: { get: vi.fn(async (id) => ({ id, project: id.replace('ml', 'p') })) },
    projects: {
      get: vi.fn(async (id) => ({ id, writers: id === 'p3' ? [] : ['u'] })),
    },
  });
  const user = { id: 'u' };
  const types = new Map([
    ['suf', 'suffix'],
    ['pre', 'prefix'],
  ]);

  it('groups the morphemes by project, and leaves words, untyped entries and read-only projects', async () => {
    const c = client([
      ['suf', 'm-1', 'ml1', 'morpheme', 1],
      ['pre', 'm-2', 'ml2', 'morpheme', 1],
      ['suf', 'm-3', 'ml1', 'morpheme', 1],
      ['suf', 'w-1', 'wl1', 'word', 1],
      ['cat', 'm-4', 'ml1', 'morpheme', 1],
      ['suf', 'm-5', 'ml3', 'morpheme', 1],
    ]);
    const plan = await planKeptTypes(c, user, { vocabId: 'v1' }, (id) => types.get(id));
    expect(plan).toEqual([
      {
        projectId: 'p1',
        rows: [
          { id: 'm-1', metadata: set('suffix') },
          { id: 'm-3', metadata: set('suffix') },
        ],
      },
      { projectId: 'p2', rows: [{ id: 'm-2', metadata: set('prefix') }] },
    ]);
    const b = { tokens: { bulkUpdate: vi.fn() } };
    queueKeptTypes(b, plan);
    expect(b.tokens.bulkUpdate).toHaveBeenCalledTimes(2);
  });

  it('reads nothing for entries that go by no type', async () => {
    const c = client([]);
    expect(await planKeptTypes(c, user, { itemIds: ['cat'] }, (id) => types.get(id))).toEqual([]);
    expect(c.query).not.toHaveBeenCalled();
  });
});
