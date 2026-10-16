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

describe('wordCountsByProject with a word value spec', () => {
  // Surfaces per layer: a token whose surface the spec does not match is no word.
  const SURFACES = {
    'a-words': ['Ana', 'runs', '.', 'Ben', '...'],
    'b-words': ['uh', 'dog', 'uh'],
    'c-words': ['x', '.'],
  };
  const matches = (spec, s) => spec.regex.split('|').some((alt) => alt === s);
  const valueClient = () => ({
    query: vi.fn(async ({ where, scope }) => {
      const spec = where[1]?.[2]?.value;
      const out = [];
      for (const [layer, surfaces] of Object.entries(SURFACES)) {
        if (scope && !scope.projectIds.includes(layer[0])) continue;
        out.push([layer, surfaces.filter((s) => !spec || matches(spec, s)).length]);
      }
      return { results: out };
    }),
  });
  const ps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const words = (p) => `${p.id}-words`;
  // a and c share one spec, b has its own, so two more queries.
  const specs = { a: { regex: 'Ana|runs|Ben' }, b: { regex: 'dog' }, c: null };
  const spec = (p) => specs[p.id] && { regex: specs[p.id].regex };

  it('counts each project by its own spec, and a project without one by every token', async () => {
    const c = valueClient();
    expect(await wordCountsByProject(c, ps, words, null, spec)).toEqual({ a: 3, b: 1, c: 2 });
    expect(c.query).toHaveBeenCalledTimes(3);
    const scoped = c.query.mock.calls.map(([q]) => q.scope?.projectIds ?? null);
    expect(scoped).toEqual([['a', 'b', 'c'], ['a'], ['b']]);
  });
});

describe('wordCountsByProject scope', () => {
  it('counts only the listed projects that have a word layer', async () => {
    const c = client();
    await wordCountsByProject(c, projects, wordLayerId);
    expect(c.query.mock.calls[0][0].scope).toEqual({ projectIds: ['p1', 'p2'] });
  });

  it('asks nothing when no listed project has a word layer', async () => {
    const c = client();
    expect(await wordCountsByProject(c, [{ id: 'p3' }], wordLayerId)).toEqual({ p3: null });
    expect(c.query).not.toHaveBeenCalled();
  });
});
