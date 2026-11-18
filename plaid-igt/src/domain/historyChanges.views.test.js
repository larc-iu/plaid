import { describe, it, expect, vi, beforeEach } from 'vitest';

// SCL4-1: the Changes view named each entry through the whole lexicon's view
// (sense tree, homographs, numbers), and built that view again for every row
// that named one, since the lists it read were not frozen. On a lexicon of
// 8,000 entries an entry of 150 relinked words froze the tab for seconds.
// The view must be built once per list, however many rows name an entry.

const built = vi.hoisted(() => ({ n: 0 }));
vi.mock('./vocabDictionary.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    lexiconView: (items) => {
      built.n++;
      return real.lexiconView(items);
    },
  };
});

const { buildRawDoc } = await import('./test-helpers.js');
const { entryChanges, sentenceChanges } = await import('./historyChanges.js');

const ENTRIES = 40;
const items = Array.from({ length: ENTRIES }, (_, i) => ({
  id: `i${i}`,
  form: i % 2 ? 'kai' : 'ka',
  metadata: { gloss: `g${i}` },
}));

beforeEach(() => {
  built.n = 0;
});

describe('the Changes view builds the lexicon view once per list', () => {
  it('entryChanges, for many entries named', () => {
    const vocabularies = { v1: { id: 'v1', config: {}, items } };
    const rows = items.map((it) => ({
      kind: 'vocab-item',
      id: it.id,
      vocabLayer: 'v1',
      before: { ...it, metadata: { gloss: 'old' } },
      after: it,
    }));
    const got = entryChanges(rows, vocabularies);
    expect(got).toHaveLength(ENTRIES);
    expect(got[1].name).toMatch(/^kai/);
    expect(built.n).toBeLessThanOrEqual(1);
    // The caller's list is left as it was: not frozen.
    expect(Object.isFrozen(items)).toBe(false);
  });

  it('sentenceChanges, for a link on each morpheme', () => {
    const raw = buildRawDoc();
    const link = (id, item, token) => ({
      id,
      vocabItem: { id: item, layer: 'v1', form: 'kai' },
      tokens: [token],
      metadata: {},
    });
    const links = [link('l1', 'i1', 'm-1'), link('l2', 'i3', 'm-2')];
    const vocabularies = {
      v1: { id: 'v1', name: 'Lexicon', items, vocabLinks: links },
    };
    const rows = links.map((l) => ({
      kind: 'vocab-link',
      id: l.id,
      document: 'doc-1',
      before: { ...l, vocabItem: { id: 'i0', layer: 'v1', form: 'ka' } },
      after: l,
    }));
    const { sentences } = sentenceChanges({ raw, vocabularies }, rows);
    expect(sentences).toHaveLength(1);
    // One view per side (before and after), not one per morpheme named.
    expect(built.n).toBeLessThanOrEqual(2);
    expect(Object.isFrozen(items)).toBe(false);
  });
});
