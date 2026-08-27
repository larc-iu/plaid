import { describe, it, expect } from 'vitest';
import {
  buildPrecedentTable,
  buildItemIndex,
  computeAutoLinkProposals,
  precedentQueries,
} from './autoLink.js';

const res = (rows) => ({ results: rows });

describe('buildPrecedentTable', () => {
  it('uses morphForm over token value and takes the majority item', () => {
    const t = buildPrecedentTable([
      res([
        ['item-a', 'perros', null, 3], // word token: form = value
        ['item-a', 'whole', 's', 4], // morpheme token: form = metadata.form
        ['item-b', 'whole', 's', 2], // minority for "s"
      ]),
    ]);
    expect(t.get('perros')).toBe('item-a');
    expect(t.get('s')).toBe('item-a'); // 4 > 2
  });

  it('breaks count ties to the lexicographically smaller id', () => {
    const t = buildPrecedentTable([
      res([
        ['item-b', null, 'la', 2],
        ['item-a', null, 'la', 2],
      ]),
    ]);
    expect(t.get('la')).toBe('item-a'); // tie -> 'item-a' < 'item-b'
  });

  it('merges counts across vocabs', () => {
    const t = buildPrecedentTable([
      res([['item-a', null, 'se', 1]]),
      res([
        ['item-a', null, 'se', 2],
        ['item-b', null, 'se', 2],
      ]),
    ]);
    expect(t.get('se')).toBe('item-a'); // 3 > 2
  });
});

const VOCABS = {
  v1: {
    id: 'v1',
    items: [
      { id: 'i-all', form: 'todos' },
      { id: 'i-se1', form: 'se' },
      { id: 'i-se2', form: 'se' }, // homograph: 'se' is never a unique match
    ],
  },
};

const sentence = (tokens) => [{ tokens }];
const word = (id, content, vocabItem = null, morphemes = []) => ({
  id,
  content,
  vocabItem,
  morphemes,
});
const morph = (id, form, vocabItem = null) => ({ id, metadata: { form }, vocabItem });

describe('computeAutoLinkProposals', () => {
  it('links via precedent, item match, and casefold — breaking ties to the smaller id, skipping human-linked', () => {
    const precedentTable = buildPrecedentTable([res([['i-prec', null, 'nac', 2]])]);
    const sentences = sentence([
      word('w1', 'Todos'), // casefold item match -> i-all
      word('w2', 'se'), // two items share 'se' -> smaller id i-se1
      word('w3', 'todos', { id: 'x' }), // human link (no prov) -> protected, skip
      word('w4', 'unknown'), // nothing matches -> skip
      word('w5', 'whole', null, [
        morph('m1', 'nac'), // precedent -> i-prec
        morph('m2', 'todos'), // exact item match -> i-all
      ]),
    ]);
    const proposals = computeAutoLinkProposals({ sentences, vocabularies: VOCABS, precedentTable });
    // Morphemes resolve first; 'i-all' (never linked) is claimed by m2 at the
    // morpheme level, so w1's casefold match to the same item is dropped (an
    // entry is word- or morpheme-level, never both).
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-prec', form: 'nac', kind: 'morpheme' },
      { tokenId: 'm2', vocabItemId: 'i-all', form: 'todos', kind: 'morpheme' },
      { tokenId: 'w2', vocabItemId: 'i-se1', form: 'se', kind: 'word' },
    ]);
  });

  it('replaces a machine-unverified link when the rule resolves a different item; leaves same-item and protected links', () => {
    const precedentTable = buildPrecedentTable([res([['i-all', null, 'todos', 5]])]);
    const sentences = sentence([
      word('w1', 'todos', { id: 'i-se1', prov: 'machine' }), // machine, rule says i-all -> replace
      word('w2', 'todos', { id: 'i-all', prov: 'machine' }), // machine, already i-all -> no-op
      word('w3', 'todos', { id: 'i-se1', prov: 'human' }), // human/verified -> protected, skip
    ]);
    const proposals = computeAutoLinkProposals({ sentences, vocabularies: VOCABS, precedentTable });
    expect(proposals).toEqual([
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'todos', kind: 'word' },
    ]);
  });

  it('a precedent tie breaks to the lexicographically smaller item id', () => {
    const precedentTable = buildPrecedentTable([
      res([
        ['i-se1', null, 'todos', 1],
        ['i-all', null, 'todos', 1],
      ]),
    ]);
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos')]),
      vocabularies: VOCABS,
      precedentTable,
    });
    expect(proposals).toEqual([
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'todos', kind: 'word' }, // 'i-all' < 'i-se1'
    ]);
  });
});

describe('precedentQueries', () => {
  it('emits one grouped query per vocab', () => {
    const qs = precedentQueries(['v1', 'v2']);
    expect(qs).toHaveLength(2);
    expect(qs[0].return.group).toEqual(['?v', '?t.value', '?t.metadata.form']);
  });
});

describe('buildItemIndex', () => {
  it('indexes exact and casefolded forms', () => {
    const idx = buildItemIndex(VOCABS);
    expect(idx.exact.get('todos')).toEqual(['i-all']);
    expect(idx.folded.get('se')).toEqual(['i-se1', 'i-se2']);
  });
});

describe('auto-link trims edge punctuation off word forms by the ignore rule', () => {
  const cfg = { type: 'unicodePunctuation', whitelist: [] };
  const vocabularies = { v1: { id: 'v1', items: [{ id: 'i-der', form: 'derechos' }] } };
  it('links `derechos.` to the `derechos` item when a unicodePunctuation config is given', () => {
    const sentences = [
      { tokens: [{ id: 'w1', content: 'derechos.', vocabItem: null, morphemes: [] }] },
    ];
    const withCfg = computeAutoLinkProposals({
      sentences,
      vocabularies,
      precedentTable: new Map(),
      ignoredCfg: cfg,
    });
    expect(withCfg.map((p) => [p.tokenId, p.vocabItemId])).toEqual([['w1', 'i-der']]);
    const without = computeAutoLinkProposals({
      sentences,
      vocabularies,
      precedentTable: new Map(),
    });
    expect(without).toEqual([]);
  });
  it('pools precedent for `derechos.` and `derechos` under the trimmed form', () => {
    const table = buildPrecedentTable(
      [
        {
          results: [
            ['i-a', 'derechos.', null, 2],
            ['i-b', 'derechos', null, 1],
          ],
        },
      ],
      cfg,
    );
    expect(table.get('derechos')).toBe('i-a');
    expect(table.has('derechos.')).toBe(false);
  });
});

describe('item levels (word- or morpheme-level entries, never both)', () => {
  it('a word-level item is invisible to morphemes and falls through to the next candidate', () => {
    const sentences = sentence([word('w5', 'whole', null, [morph('m1', 'se')])]);
    const itemLevels = new Map([['i-se1', 'word']]);
    const proposals = computeAutoLinkProposals({
      sentences,
      vocabularies: VOCABS,
      precedentTable: new Map(),
      itemLevels,
    });
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-se2', form: 'se', kind: 'morpheme' },
    ]);
  });
  it('precedent pointing at an incompatible item is skipped, not followed', () => {
    const precedentTable = buildPrecedentTable([res([['i-se1', null, 'se', 9]])]);
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'se')]),
      vocabularies: VOCABS,
      precedentTable,
      itemLevels: new Map([['i-se1', 'morpheme']]),
    });
    expect(proposals).toEqual([{ tokenId: 'w1', vocabItemId: 'i-se2', form: 'se', kind: 'word' }]);
  });
  it('a single-morpheme word gets no word link when its morpheme is linked, even to a different homonym', () => {
    // Morpheme `se` resolves to i-se2 (i-se1 is word-level elsewhere); the word
    // `se` would be free to take i-se1, but the word IS its one morpheme.
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'se', null, [morph('m1', 'se')])]),
      vocabularies: VOCABS,
      precedentTable: new Map(),
      itemLevels: new Map([['i-se1', 'word']]),
    });
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-se2', form: 'se', kind: 'morpheme' },
    ]);
    // Same when the morpheme already carries a (human) link.
    const linked = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'se', null, [morph('m1', 'se', { id: 'i-se2' })])]),
      vocabularies: VOCABS,
      precedentTable: new Map(),
      itemLevels: new Map([['i-se2', 'morpheme']]),
    });
    expect(linked).toEqual([]);
  });
  it('a single-morpheme word matching a never-linked item links the morpheme only', () => {
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos', null, [morph('m1', 'todos')])]),
      vocabularies: VOCABS,
      precedentTable: new Map(),
    });
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-all', form: 'todos', kind: 'morpheme' },
    ]);
  });
  it('mixed items are never proposed', () => {
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos')]),
      vocabularies: VOCABS,
      precedentTable: new Map(),
      itemLevels: new Map([['i-all', 'mixed']]),
    });
    expect(proposals).toEqual([]);
  });
});
