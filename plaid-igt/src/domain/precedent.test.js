import { describe, it, expect } from 'vitest';
import {
  KINDS,
  SLOT_LINK,
  createTally,
  addPrecedent,
  mergeTally,
  linkPrecedentQueries,
  valuePrecedentQueries,
  foldLinkRows,
  foldValueRows,
  foldProject,
  foldDocumentLinks,
  foldDocumentValues,
  precedentCounts,
  pickMajority,
  precedentForm,
} from './precedent.js';

const res = (rows) => ({ results: rows });
const links = (tally, form, kind, opts) => precedentCounts(tally, kind, form, SLOT_LINK, opts);
// The auto-linker's reading: most-linked item, ties to the smallest id.
const winner = (tally, form, kind) =>
  pickMajority(links(tally, form, kind), { tieBreak: 'smallest' });
const ignored = { type: 'unicodePunctuation', whitelist: [] };

describe('link precedent from project rows', () => {
  it('uses morphForm over token value and takes the majority item', () => {
    const t = foldLinkRows(createTally(), [
      res([
        ['item-a', 'perros', null, 'word', null, 3], // word token: form = value
        ['item-a', 'whole', 's', 'morpheme', null, 4], // morpheme token: form = metadata.form
        ['item-b', 'whole', 's', 'morpheme', null, 2], // minority for "s"
      ]),
    ]);
    expect(winner(t, 'perros', 'word')).toBe('item-a');
    expect(winner(t, 's', 'morpheme')).toBe('item-a'); // 4 > 2
    expect(links(t, 's', 'morpheme')).toEqual(
      new Map([
        ['item-a', 4],
        ['item-b', 2],
      ]),
    );
  });

  it('breaks count ties to the lexicographically smaller id (and refuses them without a tiebreak)', () => {
    const t = foldLinkRows(createTally(), [
      res([
        ['item-b', null, 'la', 'morpheme', null, 2],
        ['item-a', null, 'la', 'morpheme', null, 2],
      ]),
    ]);
    expect(winner(t, 'la', 'morpheme')).toBe('item-a');
    expect(pickMajority(links(t, 'la', 'morpheme'))).toBeNull();
  });

  it('merges counts across vocabs', () => {
    const t = foldLinkRows(createTally(), [
      res([['item-a', null, 'se', 'morpheme', null, 1]]),
      res([
        ['item-a', null, 'se', 'morpheme', null, 2],
        ['item-b', null, 'se', 'morpheme', null, 2],
      ]),
    ]);
    expect(winner(t, 'se', 'morpheme')).toBe('item-a'); // 3 > 2
  });

  it('answers each kind with its own counts, and a kind without any with what every kind did', () => {
    const t = foldLinkRows(createTally(), [
      res([
        ['item-w', 'se', null, 'word', null, 5],
        ['item-m', 'whole', 'se', 'morpheme', null, 2],
        ['item-x', 'se', null, 'other-app', null, 9], // another app's layer: overall only
      ]),
    ]);
    expect(winner(t, 'se', 'word')).toBe('item-w');
    expect(winner(t, 'se', 'morpheme')).toBe('item-m');
    expect(winner(t, 'se', 'never-linked-kind')).toBe('item-x');
    expect(links(t, 'nope', 'word')).toBeNull();
  });

  it('pools `derechos.` and `derechos` under the trimmed form', () => {
    const t = foldLinkRows(
      createTally(),
      [
        res([
          ['i-a', 'derechos.', null, 'word', null, 2],
          ['i-b', 'derechos', null, 'word', null, 1],
        ]),
      ],
      ignored,
    );
    expect(winner(t, 'derechos', 'word')).toBe('i-a');
    expect(links(t, 'derechos.', 'word')).toBeNull();
  });
});

describe('queries', () => {
  it('link queries: one grouped query per vocab, optionally scoped to one document', () => {
    const qs = linkPrecedentQueries(['v1', 'v2'], { projectId: 'p1' });
    expect(qs).toHaveLength(2);
    expect(qs[0].return.group).toEqual([
      '?v',
      '?t.value',
      '?t.metadata.form',
      '?tl.config.plaid.role',
      '?v.metadata.morphType',
    ]);
    expect(qs[0].where).toContainEqual(['token', '?t', { layer: '?tl' }]);
    const [q] = linkPrecedentQueries(['v1'], { projectId: 'p1', docId: 'doc-1' });
    expect(q.where).toContainEqual(['token', '?t', { layer: '?tl', doc: 'doc-1' }]);
  });

  it('link queries count the links of this project only, never those of a project sharing the vocabulary', () => {
    for (const q of [
      ...linkPrecedentQueries(['v1', 'v2'], { projectId: 'p1' }),
      ...linkPrecedentQueries(['v1'], { projectId: 'p1', docId: 'doc-1' }),
    ]) {
      expect(q.scope).toEqual({ projectIds: ['p1'] });
    }
    // Without the project the query would count every project the login reads.
    expect(() => linkPrecedentQueries(['v1'])).toThrow();
    expect(() => linkPrecedentQueries(['v1'], { docId: 'doc-1' })).toThrow();
  });

  it('value queries: one per word- and morpheme-scope field, grouped by form, value and provenance', () => {
    const layerInfo = {
      primaryTokenLayer: { id: 'wordL' },
      morphemeTokenLayer: { id: 'morphL' },
      spanLayers: {
        word: [{ id: 'posL', name: 'POS' }],
        morpheme: [{ id: 'glossL', name: 'Gloss' }],
        sentence: [{ id: 'trL', name: 'Translation' }],
      },
    };
    const qs = valuePrecedentQueries(layerInfo, { docId: 'doc-1' });
    expect(qs.map((q) => [q.kind, q.field])).toEqual([
      ['word', 'POS'],
      ['morpheme', 'Gloss'],
    ]);
    expect(qs[0].query.where).toEqual([
      ['span', '?s', { layer: 'posL', doc: 'doc-1' }],
      ['token', '?t', { layer: 'wordL', doc: 'doc-1' }],
      ['covers', '?s', '?t'],
    ]);
    expect(valuePrecedentQueries(layerInfo)[0].query.where[0]).toEqual([
      'span',
      '?s',
      { layer: 'posL' },
    ]);
    expect(qs[0].query.return.group[0]).toBe('?t.value');
    expect(qs[1].query.return.group).toEqual([
      '?t.metadata.form',
      '?s.value',
      '?s.metadata.prov',
      '?s.metadata.provConfirmed',
    ]);
    expect(valuePrecedentQueries({ spanLayers: { word: [{ id: 'x', name: 'X' }] } })).toEqual([]);
  });
});

describe('value precedent', () => {
  it('folds project rows with their provenance state; excludeMachine drops unverified machine values', () => {
    const t = foldValueRows(createTally(), KINDS.MORPHEME, 'Gloss', [
      ['s', 'PL', null, null, 3], // human
      ['s', 'PL', 'inferred', true, 1], // verified
      ['s', '3SG', 'inferred', null, 5], // machine, unverified
    ]);
    expect(precedentCounts(t, 'morpheme', 's', 'Gloss')).toEqual(
      new Map([
        ['PL', 4],
        ['3SG', 5],
      ]),
    );
    expect(precedentCounts(t, 'morpheme', 's', 'Gloss', { excludeMachine: true })).toEqual(
      new Map([['PL', 4]]),
    );
    expect(
      pickMajority(precedentCounts(t, 'morpheme', 's', 'Gloss', { excludeMachine: true })),
    ).toBe('PL');
  });

  it('word rows are trimmed by the ignore rule; fields and kinds stay separate', () => {
    const t = createTally();
    foldValueRows(t, KINDS.WORD, 'POS', [['perros.', 'N', null, null, 2]], ignored);
    foldValueRows(t, KINDS.WORD, 'POS', [['perros', 'N', null, null, 1]], ignored);
    foldValueRows(t, KINDS.MORPHEME, 'POS', [['perros', 'X', null, null, 1]], ignored);
    expect(precedentCounts(t, 'word', 'perros', 'POS')).toEqual(new Map([['N', 3]]));
    expect(precedentCounts(t, 'word', 'perros', 'Gloss')).toBeNull();
    expect(precedentCounts(t, 'morpheme', 'perros', 'POS')).toEqual(new Map([['X', 1]]));
  });

  it('foldProject takes the editor fetch shape', () => {
    const t = foldProject(createTally(), {
      links: [res([['item-a', 'la', null, 'word', null, 2]])],
      values: [{ kind: 'word', field: 'POS', results: res([['la', 'DET', null, null, 2]]) }],
    });
    expect(winner(t, 'la', 'word')).toBe('item-a');
    expect(precedentCounts(t, 'word', 'la', 'POS')).toEqual(new Map([['DET', 2]]));
  });
});

describe('folding the open document', () => {
  const machine = { prov: 'inferred', provSource: 'x' };
  const sentences = [
    {
      tokens: [
        {
          id: 'w1',
          content: 'perros.',
          vocabItem: { id: 'item-a', prov: 'human' },
          annotations: { POS: { value: 'N' } },
          morphemes: [],
        },
        {
          id: 'w2',
          content: 'whole',
          vocabItem: null,
          annotations: { POS: { value: 'N', metadata: machine } },
          morphemes: [
            { id: 'm1', content: 'whol', metadata: {}, vocabItem: null, annotations: {} },
            {
              id: 'm2',
              content: 'e',
              metadata: { form: 's' },
              vocabItem: { id: 'item-b', prov: 'machine' },
              annotations: { Gloss: { value: 'PL' }, POS: { value: '' } },
            },
          ],
        },
      ],
    },
  ];

  it("folds the document's links onto project rows, keyed like the rows, machine links marked", () => {
    const t = foldLinkRows(
      createTally(),
      [res([['item-a', 'perros', null, 'word', null, 3]])],
      ignored,
    );
    foldDocumentLinks(t, sentences, ignored);
    expect(links(t, 'perros', 'word')).toEqual(new Map([['item-a', 4]]));
    expect(links(t, 's', 'morpheme')).toEqual(new Map([['item-b', 1]]));
    expect(links(t, 's', 'morpheme', { excludeMachine: true })).toBeNull();
    // a kind with no precedent of its own sees what any kind did
    expect(links(t, 's', 'word')).toEqual(new Map([['item-b', 1]]));
  });

  it("folds the document's values per field, skipping empties, marking machine spans", () => {
    const t = foldDocumentValues(createTally(), sentences, {
      wordFields: ['POS'],
      morphFields: ['Gloss', 'POS'],
      ignoredCfg: ignored,
    });
    expect(precedentCounts(t, 'word', 'perros', 'POS')).toEqual(new Map([['N', 1]]));
    expect(precedentCounts(t, 'word', 'whole', 'POS')).toEqual(new Map([['N', 1]]));
    expect(precedentCounts(t, 'word', 'whole', 'POS', { excludeMachine: true })).toBeNull();
    expect(precedentCounts(t, 'morpheme', 's', 'Gloss')).toEqual(new Map([['PL', 1]]));
    expect(precedentCounts(t, 'morpheme', 's', 'POS')).toBeNull();
    // the default morpheme keys by its content when it has no form
    expect(precedentCounts(t, 'morpheme', 'whol', 'Gloss')).toBeNull();
  });
});

describe('pickMajority + precedentForm + addPrecedent', () => {
  it('requires a strict majority by default, or breaks ties to the smallest value', () => {
    const tied = new Map([
      ['b', 2],
      ['a', 2],
      ['c', 1],
    ]);
    expect(pickMajority(tied)).toBeNull();
    expect(pickMajority(tied, { tieBreak: 'smallest' })).toBe('a');
    expect(pickMajority(new Map([['x', 1]]))).toBe('x');
    expect(pickMajority(null)).toBeNull();
  });

  it('ignores empty forms, empty values and non-positive counts', () => {
    const t = createTally();
    addPrecedent(t, 'word', '', 'POS', 'N');
    addPrecedent(t, 'word', 'a', 'POS', '');
    addPrecedent(t, 'word', 'a', 'POS', 'N', 0);
    expect(t.size).toBe(0);
  });

  it('precedentForm trims words by the ignore rule and leaves morphemes alone', () => {
    expect(precedentForm('perros.', KINDS.WORD, ignored)).toBe('perros');
    expect(precedentForm('s.', KINDS.MORPHEME, ignored)).toBe('s.');
    expect(precedentForm(null, KINDS.WORD, ignored)).toBe('');
  });
});

describe('multi-word expression links in project rows', () => {
  it("leaves a phrase entry out of a single form's precedent", () => {
    const t = foldLinkRows(createTally(), [
      res([
        ['i-phrase', 'el', null, 'word', 'phrase', 5],
        ['i-el', 'el', null, 'word', 'stem', 2],
        ['i-disc', 'pelo', null, 'word', 'discontiguous phrase', 3],
      ]),
    ]);
    expect(winner(t, 'el', 'word')).toBe('i-el');
    expect(links(t, 'pelo', 'word')).toBeNull();
  });
});

describe('mergeTally', () => {
  it('subtracts a document back out, and reads what drops below one as none', () => {
    const project = createTally();
    addPrecedent(project, 'word', 'kai', 'Gloss', 'go', 3);
    addPrecedent(project, 'word', 'kai', 'Gloss', 'eat', 1, { machine: true });
    const doc = createTally();
    addPrecedent(doc, 'word', 'kai', 'Gloss', 'go', 1);
    addPrecedent(doc, 'word', 'kai', 'Gloss', 'eat', 2, { machine: true });
    const t = mergeTally(mergeTally(createTally(), project), doc, -1);
    expect(precedentCounts(t, 'word', 'kai', 'Gloss')).toEqual(new Map([['go', 2]]));
    // The copy is its own: subtracting did not touch the project tally.
    expect(precedentCounts(project, 'word', 'kai', 'Gloss')).toEqual(
      new Map([
        ['go', 3],
        ['eat', 1],
      ]),
    );
  });

  it('never counts more machine-made decisions than decisions', () => {
    const t = createTally();
    addPrecedent(t, 'word', 'kai', 'Gloss', 'go', 2);
    const minus = createTally();
    addPrecedent(minus, 'word', 'kai', 'Gloss', 'go', 1, { machine: true });
    mergeTally(t, minus, -1);
    // n 1, machine -1: one decision, none of it machine-made.
    expect(precedentCounts(t, 'word', 'kai', 'Gloss', { excludeMachine: true })).toEqual(
      new Map([['go', 1]]),
    );
  });
});
