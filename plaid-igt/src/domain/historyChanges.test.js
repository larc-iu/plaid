import { describe, it, expect } from 'vitest';
import { buildRawDoc } from './test-helpers.js';
import {
  documentRowChanges,
  entryChanges,
  linkCounts,
  mergeById,
  sentenceChanges,
} from './historyChanges.js';

// What one History entry changed, from the rows core's audit.changes read
// gives and the document as of the entry's end. Each case builds the document
// AFTER the entry and the rows, and reads the sentences back as the view draws
// them: which cells changed, from what to what, and whose the old value was.

const MACHINE = { prov: 'inferred', provSource: 'job:1' };
const span = (id, layer, tokens, value, metadata = {}) => ({ id, value, tokens, metadata });

// The document after the entry: "the cat", two words with a morpheme each,
// spans as given, by layer id.
const docAfter = ({ spans = {}, ...opts } = {}) => {
  const raw = buildRawDoc(opts);
  for (const tkl of raw.textLayers[0].tokenLayers) {
    for (const sl of tkl.spanLayers) sl.spans = spans[sl.id] || [];
  }
  return raw;
};

const read = (raw, rows, vocabularies = {}) => sentenceChanges({ raw, vocabularies }, rows);
const line = (sentence, key) => sentence.lines.find((l) => l.key === key);

describe('sentenceChanges', () => {
  it('shows a machine gloss written over a blank as added, replacing nothing', () => {
    const made = span('sp1', 'msl-0', ['m-1'], 'DEF', MACHINE);
    const raw = docAfter({ spans: { 'msl-0': [made] } });
    const { sentences } = read(raw, [{ kind: 'span', id: 'sp1', layer: 'msl-0', after: made }]);
    expect(sentences).toHaveLength(1);
    const [s] = sentences;
    expect(s.number).toBe(1);
    expect(s.changes).toBe(1);
    expect(s.replaced).toBe(0);
    const gloss = line(s, 'morph:Gloss');
    expect(gloss.cells[0]).toMatchObject({
      before: '',
      after: 'DEF',
      afterProv: 'machine',
      changed: true,
      replaced: false,
    });
    expect(gloss.cells[1].changed).toBe(false);
    // The rows with nothing on either side are left out.
    expect(line(s, 'word:POS')).toBeUndefined();
  });

  it('counts a person’s gloss the entry replaced, and says whose it was', () => {
    const was = span('sp1', 'msl-0', ['m-1'], 'the', {});
    const now = span('sp1', 'msl-0', ['m-1'], 'DEF', MACHINE);
    const raw = docAfter({ spans: { 'msl-0': [now] } });
    const { sentences } = read(raw, [
      { kind: 'span', id: 'sp1', layer: 'msl-0', before: was, after: now },
    ]);
    const cell = line(sentences[0], 'morph:Gloss').cells[0];
    expect(cell).toMatchObject({
      before: 'the',
      after: 'DEF',
      beforeProv: 'human',
      replaced: true,
    });
    expect(sentences[0].replaced).toBe(1);
  });

  it('counts a contributor’s value and a confirmed one as a person’s, a machine one not', () => {
    const cases = [
      [{ prov: 'contributed', provSource: 'user:x' }, 'contributed', true],
      [{ ...MACHINE, provConfirmed: true }, 'verified', true],
      [MACHINE, 'machine', false],
    ];
    for (const [metadata, state, replaced] of cases) {
      const was = span('sp1', 'msl-0', ['m-1'], 'the', metadata);
      const now = span('sp1', 'msl-0', ['m-1'], 'DEF', MACHINE);
      const raw = docAfter({ spans: { 'msl-0': [now] } });
      const { sentences } = read(raw, [
        { kind: 'span', id: 'sp1', layer: 'msl-0', before: was, after: now },
      ]);
      expect(line(sentences[0], 'morph:Gloss').cells[0]).toMatchObject({
        beforeProv: state,
        replaced,
      });
    }
  });

  it('shows a confirmation as a change of whose the value is, replacing nothing', () => {
    const was = span('sp1', 'msl-0', ['m-1'], 'DEF', MACHINE);
    const now = span('sp1', 'msl-0', ['m-1'], 'DEF', { ...MACHINE, provConfirmed: true });
    const raw = docAfter({ spans: { 'msl-0': [now] } });
    const { sentences } = read(raw, [
      { kind: 'span', id: 'sp1', layer: 'msl-0', before: was, after: now },
    ]);
    expect(line(sentences[0], 'morph:Gloss').cells[0]).toMatchObject({
      before: 'DEF',
      after: 'DEF',
      beforeProv: 'machine',
      afterProv: 'verified',
      changed: true,
      replaced: false,
    });
  });

  it('shows a deleted word as a column of its own, its person’s gloss replaced', () => {
    const gloss = span('sp2', 'msl-0', ['m-2'], 'cat', {});
    const raw = docAfter({
      words: [{ id: 'w-1', begin: 0, end: 3 }],
      morphemes: [{ id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} }],
    });
    const { sentences } = read(raw, [
      {
        kind: 'token',
        id: 'w-2',
        layer: 'wordL',
        text: 'text-1',
        before: { id: 'w-2', begin: 4, end: 7 },
      },
      {
        kind: 'token',
        id: 'm-2',
        layer: 'morphL',
        text: 'text-1',
        before: { id: 'm-2', begin: 4, end: 7, precedence: 1 },
      },
      { kind: 'span', id: 'sp2', layer: 'msl-0', before: gloss },
    ]);
    const [s] = sentences;
    expect(s.columns.map((c) => [c.id, c.state])).toEqual([
      ['w-1', 'kept'],
      ['w-2', 'deleted'],
    ]);
    expect(line(s, 'surface').cells[1]).toMatchObject({ before: 'cat', after: '' });
    expect(line(s, 'morph:Gloss').cells[1]).toMatchObject({ before: 'cat', replaced: true });
  });

  it('shows a text edit as the old and the new word', () => {
    const raw = docAfter({ body: 'the dog' });
    const { sentences } = read(raw, [
      {
        kind: 'text',
        id: 'text-1',
        layer: 'tl-1',
        before: { id: 'text-1', body: 'the cat' },
        after: { id: 'text-1', body: 'the dog' },
      },
    ]);
    const [s] = sentences;
    expect(s.text).toMatchObject({ before: 'the cat', after: 'the dog', changed: true });
    expect(line(s, 'surface').cells[1]).toMatchObject({
      before: 'cat',
      after: 'dog',
      changed: true,
    });
    // The word and its morpheme, which reads the text: the text line says
    // no more than they do and is not counted again.
    expect(line(s, 'morphemes').cells[1]).toMatchObject({ before: 'cat', after: 'dog' });
    expect(s.changes).toBe(2);
  });

  it('leaves out a sentence a text edit only moved', () => {
    const raw = docAfter({
      body: 'aab cd',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 6 },
      ],
      sentences: [
        { id: 's-1', begin: 0, end: 3 },
        { id: 's-2', begin: 4, end: 6 },
      ],
      morphemes: [],
    });
    const tok = (id, layer, b, a) => ({
      kind: 'token',
      id,
      layer,
      text: 'text-1',
      before: { id, begin: b[0], end: b[1] },
      after: { id, begin: a[0], end: a[1] },
    });
    const { sentences } = read(raw, [
      {
        kind: 'text',
        id: 'text-1',
        layer: 'tl-1',
        before: { id: 'text-1', body: 'ab cd' },
        after: { id: 'text-1', body: 'aab cd' },
      },
      tok('s-1', 'sentL', [0, 2], [0, 3]),
      tok('s-2', 'sentL', [3, 5], [4, 6]),
      tok('w-1', 'wordL', [0, 2], [0, 3]),
      tok('w-2', 'wordL', [3, 5], [4, 6]),
    ]);
    expect(sentences.map((s) => [s.id, s.number])).toEqual([['s-1', 1]]);
    expect(line(sentences[0], 'surface').cells[0]).toMatchObject({ before: 'ab', after: 'aab' });
  });

  it('shows a deleted sentence by its number before the entry', () => {
    const raw = docAfter({
      body: 'ab cd',
      words: [{ id: 'w-1', begin: 0, end: 2 }],
      sentences: [{ id: 's-1', begin: 0, end: 2 }],
      morphemes: [],
    });
    const { sentences } = read(raw, [
      {
        kind: 'token',
        id: 's-2',
        layer: 'sentL',
        text: 'text-1',
        before: { id: 's-2', begin: 3, end: 5 },
      },
      {
        kind: 'token',
        id: 'w-2',
        layer: 'wordL',
        text: 'text-1',
        before: { id: 'w-2', begin: 3, end: 5 },
      },
    ]);
    expect(sentences.map((s) => [s.id, s.state, s.number])).toEqual([['s-2', 'deleted', 2]]);
    expect(line(sentences[0], 'surface').cells[0]).toMatchObject({ before: 'cd', after: '' });
  });

  it('shows an analysis of a word nobody had segmented as added', () => {
    const raw = docAfter({
      morphemes: [
        { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'th' } },
        { id: 'm-9', text: 'text-1', begin: 0, end: 3, precedence: 2, metadata: { form: 'e' } },
      ],
    });
    const { sentences } = read(raw, [
      {
        kind: 'token',
        id: 'm-1',
        layer: 'morphL',
        text: 'text-1',
        after: { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'th' } },
      },
      {
        kind: 'token',
        id: 'm-9',
        layer: 'morphL',
        text: 'text-1',
        after: { id: 'm-9', begin: 0, end: 3, precedence: 2, metadata: { form: 'e' } },
      },
    ]);
    const cell = line(sentences[0], 'morphemes').cells[0];
    expect(cell).toMatchObject({ before: '', after: 'th-e', replaced: false });
  });

  it('names an entry a link was made to, and a link the entry moved', () => {
    const vocab = (links) => ({
      v1: {
        id: 'v1',
        name: 'Lexicon',
        items: [
          { id: 'i1', form: 'kai', metadata: {} },
          { id: 'i2', form: 'ka', metadata: {} },
        ],
        vocabLinks: links,
      },
    });
    const link = (item, metadata = {}) => ({
      id: 'l1',
      vocabItem: { id: item, layer: 'v1', form: item === 'i1' ? 'kai' : 'ka' },
      tokens: ['m-1'],
      metadata,
    });
    const made = read(
      docAfter(),
      [{ kind: 'vocab-link', id: 'l1', document: 'doc-1', after: link('i1', MACHINE) }],
      vocab([link('i1', MACHINE)]),
    );
    expect(line(made.sentences[0], 'entry').cells[0]).toMatchObject({
      before: '',
      after: 'kai',
      afterProv: 'machine',
    });
    const moved = read(
      docAfter(),
      [{ kind: 'vocab-link', id: 'l1', document: 'doc-1', before: link('i2'), after: link('i1') }],
      vocab([link('i1')]),
    );
    expect(line(moved.sentences[0], 'entry').cells[0]).toMatchObject({
      before: 'ka',
      after: 'kai',
      replaced: true,
    });
  });

  it('shows an expression over two words the entry took away', () => {
    const mwe = {
      id: 'l9',
      vocabItem: { id: 'i9', layer: 'v1', form: 'the cat' },
      tokens: ['w-1', 'w-2'],
      metadata: {},
    };
    const vocab = {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        items: [{ id: 'i9', form: 'the cat', metadata: {} }],
        vocabLinks: [],
      },
    };
    const { sentences } = read(
      docAfter(),
      [{ kind: 'vocab-link', id: 'l9', document: 'doc-1', before: mwe }],
      vocab,
    );
    expect(sentences[0].mwes).toEqual([
      expect.objectContaining({ before: 'the cat', after: '', words: 'the cat', replaced: true }),
    ]);
  });

  it('lists a row no sentence holds apart', () => {
    const raw = docAfter({ alignmentTokens: [{ id: 'a1', text: 'text-1', begin: 0, end: 7 }] });
    const { sentences, unplaced } = read(raw, [
      {
        kind: 'token',
        id: 'a1',
        layer: 'alignL',
        text: 'text-1',
        after: { id: 'a1', begin: 0, end: 7 },
      },
    ]);
    expect(sentences).toEqual([]);
    expect(unplaced.map((r) => r.id)).toEqual(['a1']);
  });
});

describe('mergeById', () => {
  it('keeps each side’s order, an item one side lacks where it stood', () => {
    const ids = (xs) => xs.map((id) => ({ id }));
    expect(
      mergeById(ids(['a', 'b', 'c', 'd']), ids(['a', 'x', 'c', 'y'])).map((p) => [
        p.id,
        !!p.before,
        !!p.after,
      ]),
    ).toEqual([
      ['a', true, true],
      ['x', false, true],
      ['b', true, false],
      ['c', true, true],
      ['y', false, true],
      ['d', true, false],
    ]);
  });
});

describe('documentRowChanges', () => {
  it('lists the name and each metadata value the entry changed', () => {
    expect(
      documentRowChanges([
        {
          kind: 'document',
          id: 'doc-1',
          before: { name: 'Text', metadata: { speaker: 'A', place: 'X' } },
          after: { name: 'Text 1', metadata: { speaker: 'B', place: 'X' } },
        },
      ]),
    ).toEqual([
      { label: 'Name', before: 'Text', after: 'Text 1' },
      { label: 'speaker', before: 'A', after: 'B' },
    ]);
  });
});

describe('entryChanges', () => {
  const vocabularies = {
    v1: {
      id: 'v1',
      config: { igt: { fields: { gloss: { inline: true }, Note: {} } } },
      items: [
        { id: 'i1', form: 'kai', metadata: { gloss: 'go' } },
        { id: 'i2', form: 'ka', metadata: { gloss: 'go' } },
      ],
    },
  };

  it('says what each entry became, by the vocabulary’s field names', () => {
    const got = entryChanges(
      [
        {
          kind: 'vocab-item',
          id: 'i1',
          vocabLayer: 'v1',
          before: { id: 'i1', form: 'kai', metadata: { gloss: 'walk' } },
          after: { id: 'i1', form: 'kai', metadata: { gloss: 'go', Note: 'n' } },
        },
        {
          kind: 'vocab-item',
          id: 'i2',
          vocabLayer: 'v1',
          after: { id: 'i2', form: 'ka', metadata: { gloss: 'go' } },
          changedSince: true,
        },
        {
          kind: 'vocab-item',
          id: 'i3',
          vocabLayer: 'v1',
          before: { id: 'i3', form: 'ko', metadata: {} },
        },
      ],
      vocabularies,
    );
    expect(got.map((e) => [e.id, e.state, e.name])).toEqual([
      ['i1', 'changed', 'kai'],
      ['i2', 'added', 'ka'],
      ['i3', 'deleted', 'ko'],
    ]);
    expect(got[0].fields).toEqual([
      { label: 'Gloss', before: 'walk', after: 'go' },
      { label: 'Note', before: '', after: 'n' },
    ]);
    expect(got[1].changedSince).toBe(true);
  });

  it('says a deleted entry whose links went to another was merged into it', () => {
    const got = entryChanges(
      [
        {
          kind: 'vocab-item',
          id: 'i3',
          vocabLayer: 'v1',
          before: { id: 'i3', form: 'kay', metadata: {} },
        },
        {
          kind: 'vocab-link',
          id: 'l1',
          document: 'd1',
          before: { id: 'l1', vocabItem: { id: 'i3', layer: 'v1', form: 'kay' }, tokens: ['t'] },
          after: { id: 'l1', vocabItem: { id: 'i1', layer: 'v1', form: 'kai' }, tokens: ['t'] },
        },
      ],
      vocabularies,
    );
    expect(got).toEqual([
      expect.objectContaining({ id: 'i3', state: 'merged', into: { id: 'i1', name: 'kai' } }),
    ]);
  });
});

describe('linkCounts', () => {
  it('counts per document the links moved, removed and made for a vocabulary’s entries', () => {
    const link = (item, layer = 'v1') => ({ vocabItem: { id: item, layer } });
    expect(
      linkCounts(
        [
          { kind: 'vocab-link', id: 'a', document: 'd1', before: link('i3'), after: link('i1') },
          { kind: 'vocab-link', id: 'b', document: 'd1', before: link('i3') },
          { kind: 'vocab-link', id: 'c', document: 'd2', after: link('i1') },
          { kind: 'vocab-link', id: 'd', document: 'd3', after: link('x', 'v2') },
          { kind: 'span', id: 'e', document: 'd1' },
        ],
        'v1',
      ),
    ).toEqual([
      { documentId: 'd1', moved: 1, removed: 1, made: 0 },
      { documentId: 'd2', moved: 0, removed: 0, made: 1 },
    ]);
  });
});
