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
// The value of morpheme `k` of word `col` in a row of morpheme values.
const piece = (sentence, key, col, k = 0) => line(sentence, key).cells[col].pieces[k];

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
    expect(piece(s, 'morph:Gloss', 0)).toMatchObject({
      before: '',
      after: 'DEF',
      afterProv: 'machine',
      changed: true,
      replaced: false,
    });
    expect(piece(s, 'morph:Gloss', 1).changed).toBe(false);
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
    expect(piece(sentences[0], 'morph:Gloss', 0)).toMatchObject({
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
      expect(piece(sentences[0], 'morph:Gloss', 0)).toMatchObject({
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
    expect(piece(sentences[0], 'morph:Gloss', 0)).toMatchObject({
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
    expect(piece(s, 'morph:Gloss', 1)).toMatchObject({ before: 'cat', replaced: true });
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
    expect(piece(s, 'morphemes', 1)).toMatchObject({ before: 'cat', after: 'dog' });
    expect(s.changes).toBe(2);
    // A text edit replaces no one's value: the word and a morpheme with no
    // form of its own read the text.
    expect(s.replaced).toBe(0);
    expect(line(s, 'surface').cells[1].replaced).toBe(false);
    expect(piece(s, 'morphemes', 1).replaced).toBe(false);
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
    const { sentences, elsewhere } = read(raw, [
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
    // The tokens it only moved are no change anywhere.
    expect(elsewhere).toEqual({ transcript: 0, other: 0, deleted: 0 });
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
    expect(cell.pieces.map((x) => [x.joiner, x.before, x.after, x.replaced])).toEqual([
      ['', '', 'th', false],
      ['-', '', 'e', false],
    ]);
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
    expect(piece(made.sentences[0], 'entry', 0)).toMatchObject({
      before: '',
      after: 'kai',
      afterProv: 'machine',
    });
    const moved = read(
      docAfter(),
      [{ kind: 'vocab-link', id: 'l1', document: 'doc-1', before: link('i2'), after: link('i1') }],
      vocab([link('i1')]),
    );
    expect(piece(moved.sentences[0], 'entry', 0)).toMatchObject({
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

  // REV-HD-1: the unit of change is one morpheme's value.
  describe('a word of several morphemes', () => {
    const morphemes = [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: { form: 'th' } },
      { id: 'm-9', text: 'text-1', begin: 0, end: 3, precedence: 2, metadata: { form: 'e' } },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: {} },
    ];

    it('shows a machine gloss written beside a person’s as machine-made, replacing nothing', () => {
      const person = span('sp1', 'msl-0', ['m-1'], 'DEM', {});
      const made = span('sp9', 'msl-0', ['m-9'], 'DEF', MACHINE);
      const raw = docAfter({ morphemes, spans: { 'msl-0': [person, made] } });
      const { sentences } = read(raw, [{ kind: 'span', id: 'sp9', layer: 'msl-0', after: made }]);
      const [s] = sentences;
      expect(line(s, 'morph:Gloss').cells[0].pieces).toEqual([
        expect.objectContaining({
          id: 'm-1',
          joiner: '',
          before: 'DEM',
          after: 'DEM',
          afterProv: 'human',
          changed: false,
          replaced: false,
        }),
        expect.objectContaining({
          id: 'm-9',
          joiner: '-',
          before: '',
          after: 'DEF',
          afterProv: 'machine',
          changed: true,
          replaced: false,
        }),
      ]);
      expect([s.changes, s.replaced]).toEqual([1, 0]);
    });

    it('counts a person’s gloss the entry replaced beside one it left, once', () => {
      const kept = span('sp1', 'msl-0', ['m-1'], 'DEM', {});
      const was = span('sp9', 'msl-0', ['m-9'], 'PL', {});
      const now = span('sp9', 'msl-0', ['m-9'], 'DEF', MACHINE);
      const raw = docAfter({ morphemes, spans: { 'msl-0': [kept, now] } });
      const { sentences } = read(raw, [
        { kind: 'span', id: 'sp9', layer: 'msl-0', before: was, after: now },
      ]);
      const [s] = sentences;
      expect(piece(s, 'morph:Gloss', 0, 0)).toMatchObject({ changed: false, replaced: false });
      expect(piece(s, 'morph:Gloss', 0, 1)).toMatchObject({
        before: 'PL',
        after: 'DEF',
        replaced: true,
      });
      expect([s.changes, s.replaced]).toEqual([1, 1]);
    });

    it('gives each morpheme’s entry its own mark', () => {
      const vocab = (links) => ({
        v1: {
          id: 'v1',
          name: 'Lexicon',
          items: [
            { id: 'i1', form: 'th', metadata: {} },
            { id: 'i2', form: 'e', metadata: {} },
          ],
          vocabLinks: links,
        },
      });
      const link = (id, item, tok, metadata = {}) => ({
        id,
        vocabItem: { id: item, layer: 'v1', form: item === 'i1' ? 'th' : 'e' },
        tokens: [tok],
        metadata,
      });
      const person = link('l1', 'i1', 'm-1');
      const made = link('l9', 'i2', 'm-9', MACHINE);
      const { sentences } = read(
        docAfter({ morphemes }),
        [{ kind: 'vocab-link', id: 'l9', document: 'doc-1', after: made }],
        vocab([person, made]),
      );
      const [s] = sentences;
      expect(
        line(s, 'entry').cells[0].pieces.map((x) => [x.after, x.afterProv, x.changed, x.replaced]),
      ).toEqual([
        ['th', 'human', false, false],
        ['e', 'machine', true, false],
      ]);
      expect(s.replaced).toBe(0);
    });

    it('counts a person’s morpheme a machine segmentation took away', () => {
      // After: the word unsegmented again, nothing of the person's left.
      const raw = docAfter({
        morphemes: [{ id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: {} }],
      });
      const { sentences } = read(raw, [
        {
          kind: 'token',
          id: 'm-1',
          layer: 'morphL',
          text: 'text-1',
          before: { id: 'm-1', begin: 0, end: 3, precedence: 1, metadata: {} },
        },
      ]);
      expect(piece(sentences[0], 'morphemes', 0)).toMatchObject({
        before: 'the',
        after: '',
        replaced: true,
      });
    });

    // REV-HD-10: blank morphemes have no joiner to strike.
    it('shows a first gloss on a word of blank morphemes without a struck joiner', () => {
      const made = span('sp1', 'msl-0', ['m-1'], 'DEF', MACHINE);
      const raw = docAfter({ morphemes, spans: { 'msl-0': [made] } });
      const { sentences } = read(raw, [{ kind: 'span', id: 'sp1', layer: 'msl-0', after: made }]);
      expect(
        line(sentences[0], 'morph:Gloss').cells[0].pieces.map((x) => [
          x.joiner,
          x.before,
          x.after,
          x.changed,
        ]),
      ).toEqual([
        ['', '', 'DEF', true],
        ['-', '', '', false],
      ]);
      expect(sentences[0].changes).toBe(1);
    });
  });

  // REV-HD-4 and REV-HD-7: one rule for "replaced a person's value".
  describe('a person’s value replaced', () => {
    it('counts a person’s value a machine wrote again with the same text', () => {
      const was = span('sp1', 'msl-0', ['m-1'], 'DEF', {});
      const now = span('sp1', 'msl-0', ['m-1'], 'DEF', MACHINE);
      const raw = docAfter({ spans: { 'msl-0': [now] } });
      const { sentences } = read(raw, [
        { kind: 'span', id: 'sp1', layer: 'msl-0', before: was, after: now },
      ]);
      expect(piece(sentences[0], 'morph:Gloss', 0)).toMatchObject({
        before: 'DEF',
        after: 'DEF',
        beforeProv: 'human',
        afterProv: 'machine',
        changed: true,
        replaced: true,
      });
      expect([sentences[0].changes, sentences[0].replaced]).toEqual([1, 1]);
    });

    it('counts a person’s value cleared, and not one a person confirmed or a contributor kept', () => {
      const cases = [
        [{}, null, true],
        [
          { prov: 'contributed', provSource: 'user:x' },
          { provConfirmed: true, prov: 'contributed', provSource: 'user:x' },
          false,
        ],
        [{}, { prov: 'contributed', provSource: 'user:x' }, false],
      ];
      for (const [wasMd, nowMd, replaced] of cases) {
        const was = span('sp1', 'msl-0', ['m-1'], 'DEF', wasMd);
        const now = nowMd && span('sp1', 'msl-0', ['m-1'], 'DEF', nowMd);
        const raw = docAfter({ spans: { 'msl-0': now ? [now] : [] } });
        const { sentences } = read(raw, [
          { kind: 'span', id: 'sp1', layer: 'msl-0', before: was, ...(now ? { after: now } : {}) },
        ]);
        expect(piece(sentences[0], 'morph:Gloss', 0).replaced).toBe(replaced);
        expect(sentences[0].replaced).toBe(replaced ? 1 : 0);
      }
    });

    it('counts a text edit as a change, never a value replaced', () => {
      const raw = docAfter({
        body: 'xab cd',
        words: [
          { id: 'w-1', begin: 1, end: 3 },
          { id: 'w-2', begin: 4, end: 6 },
        ],
        sentences: [{ id: 's-1', begin: 0, end: 6 }],
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
        tok('s-1', 'sentL', [0, 5], [0, 6]),
        tok('w-1', 'wordL', [0, 2], [1, 3]),
        tok('w-2', 'wordL', [3, 5], [4, 6]),
        {
          kind: 'text',
          id: 'text-1',
          layer: 'tl-1',
          before: { id: 'text-1', body: 'ab cd' },
          after: { id: 'text-1', body: 'xab cd' },
        },
      ]);
      const [s] = sentences;
      expect(s.text).toMatchObject({ before: 'ab cd', after: 'xab cd', changed: true });
      expect([s.changes, s.replaced]).toEqual([1, 0]);
      expect(line(s, 'surface').cells.map((c) => c.changed)).toEqual([false, false]);
    });

    it('counts a person’s expression a machine took over', () => {
      const vocab = {
        v1: {
          id: 'v1',
          name: 'Lexicon',
          items: [{ id: 'i9', form: 'the cat', metadata: {} }],
          vocabLinks: [],
        },
      };
      const mwe = (metadata) => ({
        id: 'l9',
        vocabItem: { id: 'i9', layer: 'v1', form: 'the cat' },
        tokens: ['w-1', 'w-2'],
        metadata,
      });
      vocab.v1.vocabLinks = [mwe(MACHINE)];
      const { sentences } = read(
        docAfter(),
        [{ kind: 'vocab-link', id: 'l9', document: 'doc-1', before: mwe({}), after: mwe(MACHINE) }],
        vocab,
      );
      expect(sentences[0].mwes).toEqual([
        expect.objectContaining({ before: 'the cat', after: 'the cat', replaced: true }),
      ]);
    });
  });

  it('counts a transcript segment apart', () => {
    const raw = docAfter({ alignmentTokens: [{ id: 'a1', text: 'text-1', begin: 0, end: 7 }] });
    const { sentences, elsewhere } = read(raw, [
      {
        kind: 'token',
        id: 'a1',
        layer: 'alignL',
        text: 'text-1',
        after: { id: 'a1', begin: 0, end: 7 },
      },
    ]);
    expect(sentences).toEqual([]);
    expect(elsewhere).toEqual({ transcript: 1, other: 0, deleted: 0 });
  });

  // REV-HD-3: a change igt does not draw is counted, never dropped.
  describe('rows igt draws in no sentence', () => {
    it('counts a span of a layer igt does not draw, on igt’s words, as another annotation', () => {
      const { sentences, elsewhere } = read(docAfter(), [
        {
          kind: 'span',
          id: 'ud1',
          layer: 'ud-upos',
          before: span('ud1', 'ud-upos', ['w-1'], 'DET'),
          after: span('ud1', 'ud-upos', ['w-1'], 'NOUN'),
        },
      ]);
      expect(sentences).toEqual([]);
      expect(elsewhere).toEqual({ transcript: 0, other: 1, deleted: 0 });
    });

    it('counts a link on another app’s tokens, and a relation, as other annotations', () => {
      const raw = docAfter();
      raw.textLayers[0].tokenLayers.push({
        id: 'udWords',
        name: 'Syntactic words',
        config: {},
        tokens: [{ id: 'sw1', text: 'text-1', begin: 0, end: 3 }],
        spanLayers: [],
        vocabs: [],
      });
      const { sentences, elsewhere } = read(raw, [
        {
          kind: 'vocab-link',
          id: 'l1',
          document: 'doc-1',
          after: { id: 'l1', vocabItem: { id: 'i1', layer: 'v1', form: 'the' }, tokens: ['sw1'] },
        },
        { kind: 'relation', id: 'r1', layer: 'deps', after: { id: 'r1', value: 'det' } },
      ]);
      expect(sentences).toEqual([]);
      expect(elsewhere).toEqual({ transcript: 0, other: 2, deleted: 0 });
    });

    it('counts a span on a transcript segment with the transcript', () => {
      const raw = docAfter({ alignmentTokens: [{ id: 'a1', text: 'text-1', begin: 0, end: 7 }] });
      const alignment = raw.textLayers[0].tokenLayers.find((l) => l.id === 'alignL');
      alignment.spanLayers = [{ id: 'spk', name: 'Speaker', config: {}, spans: [] }];
      const { elsewhere } = read(raw, [
        { kind: 'span', id: 'sp', layer: 'spk', after: span('sp', 'spk', ['a1'], 'A') },
      ]);
      expect(elsewhere).toEqual({ transcript: 1, other: 0, deleted: 0 });
    });

    it('counts a change to a gloss igt shows no difference in as another annotation', () => {
      const was = span('sp1', 'msl-0', ['m-1'], 'DEF', { ...MACHINE, provProb: 0.4 });
      const now = span('sp1', 'msl-0', ['m-1'], 'DEF', { ...MACHINE, provProb: 0.9 });
      const raw = docAfter({ spans: { 'msl-0': [now] } });
      const { sentences, elsewhere } = read(raw, [
        { kind: 'span', id: 'sp1', layer: 'msl-0', before: was, after: now },
      ]);
      expect(sentences).toEqual([]);
      expect(elsewhere).toEqual({ transcript: 0, other: 1, deleted: 0 });
    });

    // REV-HD-8: a word deleted while a job ran, inside the job's group.
    it('counts a gloss on a word deleted before the entry ended apart', () => {
      const made = span('sp9', 'msl-0', ['m-9'], 'DEF', MACHINE);
      const { sentences, elsewhere } = read(docAfter(), [
        { kind: 'span', id: 'sp9', layer: 'msl-0', after: made, changedSince: true },
      ]);
      expect(sentences).toEqual([]);
      expect(elsewhere).toEqual({ transcript: 0, other: 0, deleted: 1 });
    });
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
