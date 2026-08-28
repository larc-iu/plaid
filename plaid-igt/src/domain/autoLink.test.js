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
        ['item-a', 'perros', null, 'word', 3], // word token: form = value
        ['item-a', 'whole', 's', 'morpheme', 4], // morpheme token: form = metadata.form
        ['item-b', 'whole', 's', 'morpheme', 2], // minority for "s"
      ]),
    ]);
    expect(t.get('perros').any).toBe('item-a');
    expect(t.get('s').any).toBe('item-a'); // 4 > 2
  });

  it('breaks count ties to the lexicographically smaller id', () => {
    const t = buildPrecedentTable([
      res([
        ['item-b', null, 'la', 'morpheme', 2],
        ['item-a', null, 'la', 'morpheme', 2],
      ]),
    ]);
    expect(t.get('la').any).toBe('item-a'); // tie -> 'item-a' < 'item-b'
  });

  it('merges counts across vocabs', () => {
    const t = buildPrecedentTable([
      res([['item-a', null, 'se', 'morpheme', 1]]),
      res([
        ['item-a', null, 'se', 'morpheme', 2],
        ['item-b', null, 'se', 'morpheme', 2],
      ]),
    ]);
    expect(t.get('se').any).toBe('item-a'); // 3 > 2
  });

  it('keeps a per-kind majority next to the overall one', () => {
    const t = buildPrecedentTable([
      res([
        ['item-w', 'se', null, 'word', 5],
        ['item-m', 'whole', 'se', 'morpheme', 2],
        ['item-x', 'se', null, 'other-app', 9], // another app's layer: overall only
      ]),
    ]);
    expect(t.get('se')).toEqual({ any: 'item-x', word: 'item-w', morpheme: 'item-m' });
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
    const precedentTable = buildPrecedentTable([res([['i-prec', null, 'nac', 'morpheme', 2]])]);
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
    // Morphemes resolve first; the same item may be linked from a word and a
    // morpheme (w1 and m2 both take 'i-all').
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-prec', form: 'nac', kind: 'morpheme' },
      { tokenId: 'm2', vocabItemId: 'i-all', form: 'todos', kind: 'morpheme' },
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'Todos', kind: 'word' },
      { tokenId: 'w2', vocabItemId: 'i-se1', form: 'se', kind: 'word' },
    ]);
  });

  it('replaces a machine-unverified link when the rule resolves a different item; leaves same-item and protected links', () => {
    const precedentTable = buildPrecedentTable([res([['i-all', null, 'todos', 'word', 5]])]);
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
        ['i-se1', null, 'todos', 'word', 1],
        ['i-all', null, 'todos', 'word', 1],
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
    expect(qs[0].return.group).toEqual([
      '?v',
      '?t.value',
      '?t.metadata.form',
      '?tl.config.plaid.role',
    ]);
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
            ['i-a', 'derechos.', null, 'word', 2],
            ['i-b', 'derechos', null, 'word', 1],
          ],
        },
      ],
      cfg,
    );
    expect(table.get('derechos').any).toBe('i-a');
    expect(table.has('derechos.')).toBe(false);
  });
});

describe('a word never auto-links to a bound form', () => {
  const vocabs = {
    v1: {
      id: 'v1',
      items: [
        { id: 'i-s-affix', form: 's', metadata: { morphType: 'suffix' } },
        { id: 'i-s-word', form: 's', metadata: { morphType: 'stem' } },
        { id: 'i-le', form: 'le', metadata: { morphType: 'enclitic' } },
      ],
    },
  };
  it('skips affix and clitic entries for word tokens at every tier, morphemes still take them', () => {
    const precedentTable = buildPrecedentTable([res([['i-s-affix', 's', null, 'word', 4]])]);
    const proposals = computeAutoLinkProposals({
      sentences: sentence([
        word('w1', 's'),
        word('w2', 'le'),
        word('w3', 'whole', null, [morph('m1', 's'), morph('m2', 'le')]),
      ]),
      vocabularies: vocabs,
      precedentTable,
    });
    expect(proposals.map((p) => [p.tokenId, p.vocabItemId])).toEqual([
      ['m1', 'i-s-affix'], // smallest id among the two `s` entries
      ['m2', 'i-le'],
      ['w1', 'i-s-word'], // precedent points at the suffix: skipped, next candidate
      // w2: `le` only exists as an enclitic, so no word link at all
    ]);
  });
});

describe('same-kind precedent ranks homonyms; an entry may serve both kinds', () => {
  it('a word follows what words linked, a morpheme what morphemes linked', () => {
    const precedentTable = buildPrecedentTable([
      res([
        ['i-se2', 'se', null, 'word', 3],
        ['i-se1', 'whole', 'se', 'morpheme', 9],
      ]),
    ]);
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'se'), word('w2', 'whole', null, [morph('m1', 'se')])]),
      vocabularies: VOCABS,
      precedentTable,
    });
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-se1', form: 'se', kind: 'morpheme' },
      { tokenId: 'w1', vocabItemId: 'i-se2', form: 'se', kind: 'word' },
    ]);
  });
  it('falls back to precedent of any kind, then to the smallest-id homonym', () => {
    const fromMorphemes = buildPrecedentTable([res([['i-se2', 'whole', 'se', 'morpheme', 9]])]);
    expect(
      computeAutoLinkProposals({
        sentences: sentence([word('w1', 'se')]),
        vocabularies: VOCABS,
        precedentTable: fromMorphemes,
      }),
    ).toEqual([{ tokenId: 'w1', vocabItemId: 'i-se2', form: 'se', kind: 'word' }]);
    expect(
      computeAutoLinkProposals({
        sentences: sentence([word('w1', 'se')]),
        vocabularies: VOCABS,
        precedentTable: new Map(),
      }),
    ).toEqual([{ tokenId: 'w1', vocabItemId: 'i-se1', form: 'se', kind: 'word' }]);
  });
  it('a single-morpheme word gets no word link when its morpheme is linked (one chip, not two)', () => {
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos', null, [morph('m1', 'todos')])]),
      vocabularies: VOCABS,
      precedentTable: new Map(),
    });
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-all', form: 'todos', kind: 'morpheme' },
    ]);
    // Same when the morpheme already carries a (human) link.
    const linked = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'se', null, [morph('m1', 'se', { id: 'i-se2' })])]),
      vocabularies: VOCABS,
      precedentTable: new Map(),
    });
    expect(linked).toEqual([]);
  });
  it('a multi-morpheme word may link the same entry as one of its morphemes', () => {
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos', null, [morph('m1', 'todos'), morph('m2', 'se')])]),
      vocabularies: VOCABS,
      precedentTable: new Map(),
    });
    expect(proposals.map((p) => [p.tokenId, p.vocabItemId])).toEqual([
      ['m1', 'i-all'],
      ['m2', 'i-se1'],
      ['w1', 'i-all'],
    ]);
  });
});
