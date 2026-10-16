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
    // Every token of the listed projects, by layer.
    query: vi.fn(async ({ scope }) => ({
      results: Object.entries(SURFACES)
        .filter(([layer]) => !scope || scope.projectIds.includes(layer[0]))
        .map(([layer, surfaces]) => [layer, surfaces.length]),
    })),
    // Core's token count: rows [layer, document, count], one document a layer here.
    tokenLayers: {
      countMatching: vi.fn(async (layers, spec) => ({
        results: layers.map((l) => [
          l,
          `${l}-doc`,
          SURFACES[l].filter((s) => matches(spec, s)).length,
        ]),
      })),
    },
  });
  const ps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const words = (p) => `${p.id}-words`;
  // a and b each have a spec, c none, so two token counts beside the one query.
  const specs = { a: { regex: 'Ana|runs|Ben' }, b: { regex: 'dog' }, c: null };
  const spec = (p) => specs[p.id] && { regex: specs[p.id].regex };

  it('counts each project by its own spec, and a project without one by every token', async () => {
    const c = valueClient();
    expect(await wordCountsByProject(c, ps, words, null, spec)).toEqual({ a: 3, b: 1, c: 2 });
    expect(c.query).toHaveBeenCalledTimes(1);
    expect(c.tokenLayers.countMatching.mock.calls.map(([layers]) => layers)).toEqual([
      ['a-words'],
      ['b-words'],
    ]);
  });
});
