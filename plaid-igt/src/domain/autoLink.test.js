import { describe, it, expect } from 'vitest';
import {
  AUTO_LINK_SOURCE,
  buildItemIndex,
  computeAutoLinkProposals,
  computeMweProposals,
} from './autoLink.js';
import { createTally, foldLinkRows } from './precedent.js';

const res = (rows) => ({ results: rows });
// Project link precedent as the auto-link phase builds it.
const precedentOf = (...results) => foldLinkRows(createTally(), results);

const VOCABS = {
  v1: {
    id: 'v1',
    items: [
      { id: 'i-all', form: 'todos' },
      { id: 'i-se1', form: 'se' },
      { id: 'i-se2', form: 'se' }, // homograph: 'se' is never a unique match
      { id: 'i-prec', form: 'prec' }, // reached by precedent only
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
    const precedent = precedentOf(res([['i-prec', null, 'nac', 'morpheme', null, null, null, 2]]));
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
    const proposals = computeAutoLinkProposals({ sentences, vocabularies: VOCABS, precedent });
    // Morphemes resolve first; the same item may be linked from a word and a
    // morpheme (w1 and m2 both take 'i-all').
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-prec', form: 'nac', kind: 'morpheme' },
      { tokenId: 'm2', vocabItemId: 'i-all', form: 'todos', kind: 'morpheme' },
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'Todos', kind: 'word' },
      { tokenId: 'w2', vocabItemId: 'i-se1', form: 'se', kind: 'word' },
    ]);
  });

  it('leaves the words the same run just copied an analysis onto, with their morphemes (H17-IGT-EDIT-2)', () => {
    // The copy phase linked "se" to i-se2 with its glosses. The project's
    // precedent for "se" is i-se1, which would otherwise relink it.
    const precedent = precedentOf(res([['i-se1', null, 'se', 'morpheme', null, null, null, 9]]));
    // Unverified links of this rule's own, which it would otherwise replace.
    const copied = { id: 'i-se2', prov: 'machine', provSource: AUTO_LINK_SOURCE };
    const sentences = sentence([
      word('w1', 'se', null, [morph('m1', 'se', copied)]),
      word('w2', 'se', null, [morph('m2', 'se', copied)]),
    ]);
    const proposals = computeAutoLinkProposals({
      sentences,
      vocabularies: VOCABS,
      precedent,
      leave: ['w1'],
    });
    expect(proposals).toEqual([
      { tokenId: 'm2', vocabItemId: 'i-se1', form: 'se', kind: 'morpheme' },
    ]);
  });

  it('links to a sense, not to the headword standing over it', () => {
    // A FLEx entry with several senses imports as a headword (no gloss of its
    // own) plus its senses, all sharing the form. The headword sorts first by
    // id, so without the rule every word would link to the empty one.
    const vocabs = {
      v1: {
        id: 'v1',
        items: [
          { id: 'i1', form: 'kwatha', metadata: {} },
          { id: 'i2', form: 'kwatha', metadata: { gloss: 'do', parent: 'i1', senseOrder: 1 } },
          { id: 'i3', form: 'kwatha', metadata: { gloss: 'make', parent: 'i1', senseOrder: 2 } },
        ],
      },
    };
    expect(buildItemIndex(vocabs).exact.get('kwatha')).toEqual(['i2', 'i3']);
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'kwatha')]),
      vocabularies: vocabs,
      precedent: precedentOf(),
    });
    expect(proposals).toEqual([{ tokenId: 'w1', vocabItemId: 'i2', form: 'kwatha', kind: 'word' }]);
    // A headword whose senses are spelled differently is still a candidate.
    const other = {
      v1: {
        id: 'v1',
        items: [
          { id: 'j1', form: 'ntsi', metadata: { gloss: 'tree' } },
          { id: 'j2', form: 'ntsi-ntsi', metadata: { gloss: 'wood', parent: 'j1' } },
        ],
      },
    };
    expect(buildItemIndex(other).exact.get('ntsi')).toEqual(['j1']);
  });

  it('links a multi-word expression to a sense, not to the headword above it', () => {
    const phrase = (id, extra) => ({
      id,
      form: 'kwatha basa',
      metadata: { morphType: 'phrase', ...extra },
    });
    const vocabs = {
      v1: { id: 'v1', items: [phrase('p1', {}), phrase('p2', { gloss: 'give up', parent: 'p1' })] },
    };
    const proposals = computeMweProposals({
      sentences: sentence([word('w1', 'kwatha'), word('w2', 'basa')]),
      vocabularies: vocabs,
    });
    expect(proposals).toEqual([{ tokenIds: ['w1', 'w2'], vocabItemId: 'p2', form: 'kwatha basa' }]);
  });

  it('replaces a machine-unverified link when the rule resolves a different item; leaves same-item and protected links', () => {
    const precedent = precedentOf(res([['i-all', null, 'todos', 'word', null, null, null, 5]]));
    const sentences = sentence([
      word('w1', 'todos', { id: 'i-se1', prov: 'machine', provSource: AUTO_LINK_SOURCE }), // own, rule says i-all -> replace
      word('w2', 'todos', { id: 'i-all', prov: 'machine', provSource: AUTO_LINK_SOURCE }), // own, already i-all -> no-op
      word('w3', 'todos', { id: 'i-se1', prov: 'human' }), // human/verified -> protected, skip
    ]);
    const proposals = computeAutoLinkProposals({ sentences, vocabularies: VOCABS, precedent });
    expect(proposals).toEqual([
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'todos', kind: 'word' },
    ]);
  });

  it("leaves a producer's unverified pick of an entry alone, but not a link copied by form or gone stale", () => {
    const precedent = precedentOf(res([['i-se1', null, 'se', 'morpheme', null, null, null, 9]]));
    const svc = { id: 'i-se2', prov: 'machine', provSource: 'service:cwomp-analyzer' };
    const sentences = sentence([
      // A service chose i-se2 for this occurrence: left alone.
      word('w1', 'se', null, [morph('m1', 'se', { ...svc, provPick: 'i-se2' })]),
      word('w2', 'se', null, [morph('m2', 'se')]),
      // A link copied with an analysis names no choice: replaceable.
      word('w3', 'se', null, [
        morph('m3', 'se', { ...svc, provSource: 'rule:analysis-precedent' }),
      ]),
      // Re-segmented since the service linked it: the entry is not this form.
      word('w4', 'todos', null, [morph('m4', 'todos', { ...svc, provPick: 'i-se2' })]),
      // Confirmed: left alone whatever its form.
      word('w5', 'todos', null, [
        morph('m5', 'todos', { ...svc, prov: 'verified', provPick: 'i-se2' }),
      ]),
    ]);
    const proposals = computeAutoLinkProposals({ sentences, vocabularies: VOCABS, precedent });
    expect(proposals.map((p) => [p.tokenId, p.vocabItemId])).toEqual([
      ['m2', 'i-se1'],
      ['m3', 'i-se1'],
      ['m4', 'i-all'],
    ]);
  });

  it('never proposes an entry the lexicon no longer holds, whatever the precedent says', () => {
    // A precedent read before the entry was deleted or merged away.
    const precedent = precedentOf(res([['i-gone', null, 'todos', 'word', null, null, null, 5]]));
    const sentences = sentence([word('w1', 'todos')]);
    const proposals = computeAutoLinkProposals({ sentences, vocabularies: VOCABS, precedent });
    expect(proposals).toEqual([
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'todos', kind: 'word' },
    ]);
  });

  it('follows only links a person made or confirmed: an unverified machine link is no precedent', () => {
    // The project's only links of "todos" are this rule's own, unverified,
    // to i-se1. Following them would let one run bootstrap the next, so the
    // exact-form tier decides (R28).
    const machineOnly = precedentOf(
      res([['i-se1', null, 'todos', 'word', null, 'inferred', null, 5]]),
    );
    const run = (precedent) =>
      computeAutoLinkProposals({
        sentences: sentence([word('w1', 'todos')]),
        vocabularies: VOCABS,
        precedent,
      }).map((p) => p.vocabItemId);
    expect(run(machineOnly)).toEqual(['i-all']);
    // Confirmed (a group key reads true as 1) or a contributor's: precedent.
    for (const [prov, confirmed] of [
      ['inferred', 1],
      ['inferred', true],
      ['contributed', null],
    ]) {
      expect(
        run(precedentOf(res([['i-se1', null, 'todos', 'word', null, prov, confirmed, 5]]))),
      ).toEqual(['i-se1']);
    }
  });

  it('a precedent tie breaks to the lexicographically smaller item id', () => {
    const precedent = precedentOf(
      res([
        ['i-se1', null, 'todos', 'word', null, null, null, 1],
        ['i-all', null, 'todos', 'word', null, null, null, 1],
      ]),
    );
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos')]),
      vocabularies: VOCABS,
      precedent,
    });
    expect(proposals).toEqual([
      { tokenId: 'w1', vocabItemId: 'i-all', form: 'todos', kind: 'word' }, // 'i-all' < 'i-se1'
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

describe('a form written either way is one form', () => {
  // `ẹ` is U+1EB9 precomposed, or `e` plus the combining dot below U+0323.
  // A compose code binds the bare mark, so the grid makes the second, while a
  // FLEx import forces the first. Nothing on screen tells them apart.
  const PRE = 'ẹja';
  const DEC = 'ẹja';
  const vocabs = { v1: { id: 'v1', items: [{ id: 'i-fish', form: PRE }] } };

  it('keys the index in NFC, whichever spelling the entry carries', () => {
    const idx = buildItemIndex({ v1: { id: 'v1', items: [{ id: 'i-fish', form: DEC }] } });
    expect(idx.exact.get(PRE)).toEqual(['i-fish']);
  });

  it('links a decomposed token to a precomposed entry', () => {
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', DEC)]),
      vocabularies: vocabs,
      precedent: createTally(),
    });
    expect(proposals).toEqual([{ tokenId: 'w1', vocabItemId: 'i-fish', form: DEC, kind: 'word' }]);
  });

  it('pools precedent for both spellings under one key', () => {
    const precedent = precedentOf(res([['i-prec', null, PRE, 'morpheme', null, null, null, 2]]));
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'whole', null, [morph('m1', DEC)])]),
      vocabularies: { v1: { id: 'v1', items: [{ id: 'i-prec', form: 'prec' }] } },
      precedent,
    });
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-prec', form: DEC, kind: 'morpheme' },
    ]);
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
      precedent: createTally(),
      ignoredCfg: cfg,
    });
    expect(withCfg.map((p) => [p.tokenId, p.vocabItemId])).toEqual([['w1', 'i-der']]);
    const without = computeAutoLinkProposals({
      sentences,
      vocabularies,
      precedent: createTally(),
    });
    expect(without).toEqual([]);
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
    const precedent = precedentOf(res([['i-s-affix', 's', null, 'word', null, null, null, 4]]));
    const proposals = computeAutoLinkProposals({
      sentences: sentence([
        word('w1', 's'),
        word('w2', 'le'),
        word('w3', 'whole', null, [morph('m1', 's'), morph('m2', 'le')]),
      ]),
      vocabularies: vocabs,
      precedent,
    });
    expect(proposals.map((p) => [p.tokenId, p.vocabItemId])).toEqual([
      ['m1', 'i-s-affix'], // smallest id among the two `s` entries
      ['m2', 'i-le'],
      ['w1', 'i-s-word'], // precedent points at the suffix: skipped, next candidate
      // w2: `le` only exists as an enclitic, so no word link at all
    ]);
  });
});

// A sense made by hand carries no morph type of its own: it goes by its
// headword's, in the bound-form rule and in the phrase index alike.
describe("a sense goes by its headword's morph type", () => {
  it('keeps a word off a hand-made sense of an affix, and links the morpheme to it', () => {
    const vocabs = {
      v1: {
        id: 'v1',
        items: [
          { id: 'i-head', form: 'ler', metadata: { morphType: 'suffix' } },
          { id: 'i-sense', form: 'ler', metadata: { parent: 'i-head', senseOrder: 1 } },
        ],
      },
    };
    expect(buildItemIndex(vocabs).bound.has('i-sense')).toBe(true);
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'ler'), word('w2', 'x', null, [morph('m1', 'ler')])]),
      vocabularies: vocabs,
      precedent: precedentOf(res([])),
    });
    expect(proposals.map((p) => [p.tokenId, p.vocabItemId])).toEqual([['m1', 'i-sense']]);
  });

  it('proposes the sense of a phrase headword for a run of words, never the headword', () => {
    const vocabs = {
      v1: {
        id: 'v1',
        items: [
          { id: 'i-head', form: 'sit down', metadata: { morphType: 'phrase' } },
          { id: 'i-sense', form: 'sit down', metadata: { parent: 'i-head', senseOrder: 1 } },
        ],
      },
    };
    const proposals = computeMweProposals({
      sentences: sentence([word('w1', 'sit'), word('w2', 'down')]),
      vocabularies: vocabs,
    });
    expect(proposals.map((p) => p.vocabItemId)).toEqual(['i-sense']);
  });
});

describe('same-kind precedent ranks homonyms; an entry may serve both kinds', () => {
  it('a word follows what words linked, a morpheme what morphemes linked', () => {
    const precedent = precedentOf(
      res([
        ['i-se2', 'se', null, 'word', null, null, null, 3],
        ['i-se1', 'whole', 'se', 'morpheme', null, null, null, 9],
      ]),
    );
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'se'), word('w2', 'whole', null, [morph('m1', 'se')])]),
      vocabularies: VOCABS,
      precedent,
    });
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-se1', form: 'se', kind: 'morpheme' },
      { tokenId: 'w1', vocabItemId: 'i-se2', form: 'se', kind: 'word' },
    ]);
  });
  it('falls back to precedent of any kind, then to the smallest-id homonym', () => {
    const fromMorphemes = precedentOf(
      res([['i-se2', 'whole', 'se', 'morpheme', null, null, null, 9]]),
    );
    expect(
      computeAutoLinkProposals({
        sentences: sentence([word('w1', 'se')]),
        vocabularies: VOCABS,
        precedent: fromMorphemes,
      }),
    ).toEqual([{ tokenId: 'w1', vocabItemId: 'i-se2', form: 'se', kind: 'word' }]);
    expect(
      computeAutoLinkProposals({
        sentences: sentence([word('w1', 'se')]),
        vocabularies: VOCABS,
        precedent: createTally(),
      }),
    ).toEqual([{ tokenId: 'w1', vocabItemId: 'i-se1', form: 'se', kind: 'word' }]);
  });
  it('a single-morpheme word gets no word link when its morpheme is linked (one chip, not two)', () => {
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos', null, [morph('m1', 'todos')])]),
      vocabularies: VOCABS,
      precedent: createTally(),
    });
    expect(proposals).toEqual([
      { tokenId: 'm1', vocabItemId: 'i-all', form: 'todos', kind: 'morpheme' },
    ]);
    // Same when the morpheme already carries a (human) link.
    const linked = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'se', null, [morph('m1', 'se', { id: 'i-se2' })])]),
      vocabularies: VOCABS,
      precedent: createTally(),
    });
    expect(linked).toEqual([]);
  });
  it('a multi-morpheme word may link the same entry as one of its morphemes', () => {
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'todos', null, [morph('m1', 'todos'), morph('m2', 'se')])]),
      vocabularies: VOCABS,
      precedent: createTally(),
    });
    expect(proposals.map((p) => [p.tokenId, p.vocabItemId])).toEqual([
      ['m1', 'i-all'],
      ['m2', 'i-se1'],
      ['w1', 'i-all'],
    ]);
  });
});

describe('phrase entries and single tokens', () => {
  const vocabs = {
    v1: {
      id: 'v1',
      items: [
        { id: 'i-phr', form: 'sit', metadata: { morphType: 'phrase' } },
        { id: 'i-sit', form: 'sit', metadata: { morphType: 'stem' } },
      ],
    },
  };

  it('never resolve to a phrase-typed entry, by precedent or by form', () => {
    expect(buildItemIndex(vocabs).phrase.has('i-phr')).toBe(true);
    const precedent = precedentOf(res([['i-phr', 'sit', null, 'word', 'phrase', null, null, 9]]));
    const proposals = computeAutoLinkProposals({
      sentences: sentence([word('w1', 'sit'), word('w2', 'Sit')]),
      vocabularies: vocabs,
      precedent,
    });
    expect(proposals.map((p) => p.vocabItemId)).toEqual(['i-sit', 'i-sit']);
  });
});

describe('computeMweProposals', () => {
  const vocabs = {
    v1: {
      id: 'v1',
      items: [
        { id: 'i-sit', form: 'sit down', metadata: { morphType: 'phrase' } },
        { id: 'i-give', form: 'give up', metadata: { morphType: 'phrase' } },
        { id: 'i-long', form: 'sit down and give up', metadata: { morphType: 'phrase' } },
        { id: 'i-word', form: 'sit', metadata: { morphType: 'stem' } },
      ],
    },
  };
  const words = (...contents) => contents.map((c, i) => ({ id: `w${i + 1}`, content: c }));

  it('links runs whose joined form matches a phrase entry, exact before casefold, longest too', () => {
    const s = { tokens: words('Sit', 'down', 'and', 'give', 'up', '.'), mwes: [] };
    const out = computeMweProposals({ sentences: [s], vocabularies: vocabs });
    expect(out.map((p) => [p.vocabItemId, p.tokenIds])).toEqual([
      ['i-sit', ['w1', 'w2']],
      ['i-long', ['w1', 'w2', 'w3', 'w4', 'w5']],
      ['i-give', ['w4', 'w5']],
    ]);
  });

  it('follows what the document already links by hand, and skips runs already covered', () => {
    const s = {
      tokens: words('give', 'up', 'then', 'give', 'up'),
      mwes: [
        {
          linkId: 'l1',
          item: { id: 'i-other' },
          prov: 'human',
          memberIdx: [0, 1],
          memberTokenIds: ['w1', 'w2'],
        },
      ],
    };
    const out = computeMweProposals({ sentences: [s], vocabularies: vocabs });
    // The document's own choice for "give up" outranks the lexicon's form match.
    expect(out).toEqual([{ tokenIds: ['w4', 'w5'], vocabItemId: 'i-other', form: 'give up' }]);
  });

  it('does not learn from unverified machine links, nor from discontiguous ones', () => {
    const s = {
      tokens: words('give', 'it', 'up', 'give', 'up'),
      mwes: [
        {
          linkId: 'l1',
          item: { id: 'i-machine' },
          prov: 'machine',
          memberIdx: [3, 4],
          memberTokenIds: ['w4', 'w5'],
        },
        {
          linkId: 'l2',
          item: { id: 'i-disc' },
          prov: 'human',
          memberIdx: [0, 2],
          memberTokenIds: ['w1', 'w3'],
        },
      ],
    };
    const out = computeMweProposals({ sentences: [s], vocabularies: vocabs });
    expect(out).toEqual([]);
  });

  it('stops a run at punctuation the project ignores', () => {
    const ignoredCfg = { type: 'unicodePunctuation' };
    const s = { tokens: words('sit', ',', 'down'), mwes: [] };
    expect(computeMweProposals({ sentences: [s], vocabularies: vocabs, ignoredCfg })).toEqual([]);
  });
});
