import { describe, it, expect, vi } from 'vitest';
import { planKeptTypes, queueKeptTypes } from './keptMorphType.js';

// Ruling Q1: the morphemes a delete or an unlink leaves keep the type their
// entry gave them, written where this person can write, one bulk update per
// project.
const set = (value) => [{ op: 'set', path: ['morphType'], value }];

describe('planKeptTypes', () => {
  const client = (rows) => ({
    query: vi.fn(async (q) => ({
      results: q.return.group[0] === '?d' ? [['doc-1', rows.length]] : rows,
    })),
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

  // REV-FX-VOCAB-3: a query answers at most 100,000 rows, so the links are
  // read a few documents at a time, and a read that still comes back cut
  // short refuses rather than leave morphemes untyped.
  it('reads the links in document chunks under the row limit', async () => {
    const asked = [];
    const c = client([]);
    c.query = vi.fn(async (q) => {
      if (q.return.group[0] === '?d') {
        return {
          results: [
            ['d1', 60000],
            ['d2', 60000],
            ['d3', 10],
          ],
        };
      }
      const docs = q.where.find((w) => w[0] === 'token')[2].doc;
      asked.push(docs);
      return { results: docs.map((d) => ['suf', `m-${d}`, 'ml1', 'morpheme', 1]) };
    });
    const plan = await planKeptTypes(c, user, { itemIds: ['suf'] }, (id) => types.get(id));
    expect(asked).toEqual([['d1'], ['d2', 'd3']]);
    expect(plan[0].rows.map((r) => r.id)).toEqual(['m-d1', 'm-d2', 'm-d3']);
  });

  it('refuses when a read comes back cut short', async () => {
    const c = client([]);
    c.query = vi.fn(async () => ({ results: [], truncated: true }));
    await expect(
      planKeptTypes(c, user, { itemIds: ['suf'] }, (id) => types.get(id)),
    ).rejects.toThrow();
  });
});
