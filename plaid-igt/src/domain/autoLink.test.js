import { describe, it, expect } from 'vitest';
import { buildPrecedentTable, buildItemIndex, computeAutoLinkProposals, precedentQueries } from './autoLink.js';

const res = (rows) => ({ results: rows });

describe('buildPrecedentTable', () => {
  it('uses morphForm over token value and requires a strict majority', () => {
    const t = buildPrecedentTable([res([
      ['item-a', 'perros', null, 3],   // word token: form = value
      ['item-a', 'whole', 's', 4],     // morpheme token: form = metadata.form
      ['item-b', 'whole', 's', 2],     // minority for "s"
    ])]);
    expect(t.get('perros')).toEqual({ itemId: 'item-a', contested: false });
    expect(t.get('s')).toEqual({ itemId: 'item-a', contested: false }); // 4 > 2
  });

  it('marks ties contested (and they never link)', () => {
    const t = buildPrecedentTable([res([
      ['item-a', null, 'la', 2],
      ['item-b', null, 'la', 2],
    ])]);
    expect(t.get('la')).toEqual({ itemId: null, contested: true });
  });

  it('merges counts across vocabs', () => {
    const t = buildPrecedentTable([
      res([['item-a', null, 'se', 1]]),
      res([['item-a', null, 'se', 2], ['item-b', null, 'se', 2]]),
    ]);
    expect(t.get('se')).toEqual({ itemId: 'item-a', contested: false }); // 3 > 2
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
const word = (id, content, vocabItem = null, morphemes = []) => ({ id, content, vocabItem, morphemes });
const morph = (id, form, vocabItem = null) => ({ id, metadata: { form }, vocabItem });

describe('computeAutoLinkProposals', () => {
  it('links via precedent, unique item, and casefold — skipping ambiguity and human-linked', () => {
    const precedentTable = buildPrecedentTable([res([['i-prec', null, 'nac', 2]])]);
    const sentences = sentence([
      word('w1', 'Todos'),                       // casefold unique item -> i-all
      word('w2', 'se'),                           // two items share the form -> skip
      word('w3', 'todos', { id: 'x' }),           // human link (no prov) -> protected, skip
      word('w4', 'unknown'),                      // nothing matches -> skip
      word('w5', 'whole', null, [
        morph('m1', 'nac'),                       // precedent -> i-prec
        morph('m2', 'todos'),                     // exact unique item -> i-all
      ]),
    ]);
    const proposals = computeAutoLinkProposals({ sentences, vocabularies: VOCABS, precedentTable });
    expect(proposals).toEqual([
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'Todos', kind: 'word' },
      { tokenId: 'm1', vocabItemId: 'i-prec', form: 'nac', kind: 'morpheme' },
      { tokenId: 'm2', vocabItemId: 'i-all', form: 'todos', kind: 'morpheme' },
    ]);
  });

  it('replaces a machine-unverified link when the rule resolves a different item; leaves same-item and protected links', () => {
    const precedentTable = buildPrecedentTable([res([['i-all', null, 'todos', 5]])]);
    const sentences = sentence([
      word('w1', 'todos', { id: 'i-se1', inferred: true }),   // machine, rule says i-all -> replace
      word('w2', 'todos', { id: 'i-all', inferred: true }),   // machine, already i-all -> no-op
      word('w3', 'todos', { id: 'i-se1', inferred: false }),  // human/verified -> protected, skip
    ]);
    const proposals = computeAutoLinkProposals({ sentences, vocabularies: VOCABS, precedentTable });
    expect(proposals).toEqual([
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'todos', kind: 'word' },
    ]);
  });

  it('a contested precedent skips even when an item would match uniquely', () => {
    const precedentTable = buildPrecedentTable([res([
      ['i-all', null, 'todos', 1],
      ['i-se1', null, 'todos', 1],
    ])]);
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos')]),
      vocabularies: VOCABS,
      precedentTable,
    });
    expect(proposals).toEqual([]);
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
