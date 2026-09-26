import { describe, it, expect, vi } from 'vitest';
import { wordCountsByProject } from './layerCounts.js';

// Rows as the server groups them: [layer, count], or [layer, doc, count]
// when the query also groups by document.
const TOKENS = [
  // p1: set up for UD from another app. d1 was opened (3 words over its 3
  // tokens), d2 never was (no words yet, 5 tokens).
  { layer: 'p1-words', doc: 'd1', n: 3 },
  { layer: 'p1-tokens', doc: 'd1', n: 3 },
  { layer: 'p1-tokens', doc: 'd2', n: 5 },
  // p2: native, every document has its words.
  { layer: 'p2-words', doc: 'd3', n: 7 },
  { layer: 'p2-tokens', doc: 'd3', n: 6 },
];

const client = () => ({
  query: vi.fn(async ({ scope, return: { group } }) => {
    const byDoc = group.length === 2;
    const counts = new Map();
    for (const t of TOKENS) {
      if (scope && !scope.projectIds.includes(t.layer.split('-')[0])) continue;
      const key = byDoc ? `${t.layer}\u0000${t.doc}` : t.layer;
      counts.set(key, (counts.get(key) || 0) + t.n);
    }
    return { results: [...counts].map(([k, n]) => [...k.split('\u0000'), n]) };
  }),
});

const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
const wordLayerId = (p) => (p.id === 'p3' ? null : `${p.id}-words`);
const seedLayerId = (p) => (p.id === 'p3' ? null : `${p.id}-tokens`);

describe('wordCountsByProject', () => {
  it('counts the word layer', async () => {
    expect(await wordCountsByProject(client(), projects, wordLayerId)).toEqual({
      p1: 3,
      p2: 7,
      p3: null,
    });
  });

  it('counts a document with no words yet by its tokens, as the document list does', async () => {
    expect(await wordCountsByProject(client(), projects, wordLayerId, seedLayerId)).toEqual({
      p1: 8,
      p2: 7,
      p3: null,
    });
  });

  it('asks per document only for a project with fewer words than tokens', async () => {
    const c = client();
    await wordCountsByProject(c, projects, wordLayerId, seedLayerId);
    expect(c.query).toHaveBeenCalledTimes(2);
    expect(c.query.mock.calls[1][0].scope).toEqual({ projectIds: ['p1'] });
  });

  it('asks once when every project has its words', async () => {
    const c = client();
    await wordCountsByProject(c, [{ id: 'p2' }], wordLayerId, seedLayerId);
    expect(c.query).toHaveBeenCalledTimes(1);
  });
});
