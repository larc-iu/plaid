// A document for the tests of what opening a flagged value lists: one value,
// sbj:3.pfv, glossing a suffix, a stem alone in its word, and a stem beside
// another stem. Under a mixed tagset the grid flags the suffix's and the
// second stem's, and passes the lone stem's. Not imported by app code.

import { buildRawDoc } from '@/domain/test-helpers';

export const MIXED = {
  delimiters: '.',
  mode: 'mixed',
  values: [{ value: 'PL' }, { value: '1SG' }],
};

export const GLOSS_DOMAIN = { kind: 'span', scope: 'morpheme', field: 'Gloss', layerId: 'msl-0' };

const morph = (id, begin, end, precedence, form, morphType) => ({
  id,
  text: 'text-1',
  begin,
  end,
  precedence,
  metadata: { form, morphType },
});

const cellReadingDoc = () => {
  const raw = buildRawDoc({
    body: 'kati sa harbu',
    words: [
      { id: 'w-1', begin: 0, end: 4 },
      { id: 'w-2', begin: 5, end: 7 },
      { id: 'w-3', begin: 8, end: 13 },
    ],
    sentences: [
      { id: 's-1', begin: 0, end: 4 },
      { id: 's-2', begin: 5, end: 7 },
      { id: 's-3', begin: 8, end: 13 },
    ],
    morphemes: [
      morph('m-1', 0, 4, 1, 'ka', 'stem'),
      morph('m-2', 0, 4, 2, 'ti', 'suffix'),
      morph('m-3', 5, 7, 1, 'sa', 'stem'),
      morph('m-4', 8, 13, 1, 'har', 'stem'),
      morph('m-5', 8, 13, 2, 'bu', 'stem'),
    ],
  });
  raw.textLayers[0].tokenLayers[2].spanLayers[0].spans = [
    { id: 'sp-1', tokens: ['m-1'], value: 'go' },
    { id: 'sp-2', tokens: ['m-2'], value: 'sbj:3.pfv' },
    { id: 'sp-3', tokens: ['m-3'], value: 'sbj:3.pfv' },
    { id: 'sp-4', tokens: ['m-4'], value: 'dog' },
    { id: 'sp-5', tokens: ['m-5'], value: 'sbj:3.pfv' },
  ];
  return raw;
};

/** The hit ids of sbj:3.pfv in cellReadingDoc. */
const VALUE_HITS = ['sp-2', 'sp-3', 'sp-5'];

/**
 * A client that answers a hit search for sbj:3.pfv: the per-document count
 * (every occurrence, in each of `docIds`), each document's hit ids, and the
 * document itself.
 */
export const hitsClient = (docIds = ['doc-1']) => ({
  query: async (q) =>
    q?.return
      ? { results: docIds.map((d) => [d, VALUE_HITS.length]) }
      : { results: VALUE_HITS.map((id) => [id]) },
  documents: { get: async (id) => ({ ...cellReadingDoc(), id, name: `Text ${id}` }) },
});
