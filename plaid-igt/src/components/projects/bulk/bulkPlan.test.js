import { describe, it, expect } from 'vitest';
import { IgtDocument } from '../../../domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient } from '../../../domain/test-helpers.js';
import {
  buildReplacer,
  collectRespellRows,
  collectLexiconRows,
  respellOps,
  collectFieldRows,
  collectOccurrenceRows,
  tallyCandidates,
  analysisLabel,
  collectLinksToMove,
  groupByDoc,
} from './bulkPlan.js';

const docOf = (opts) => new IgtDocument({ raw: buildRawDoc(opts), client: makeFakeClient() });

describe('buildReplacer', () => {
  it('contains: case-insensitive literal, every occurrence, $ stays literal', () => {
    const { apply } = buildReplacer('ka', 'contains', '$c');
    expect(apply('Kaka')).toBe('$c$c');
    expect(apply('dog')).toBeNull();
    expect(apply('')).toBeNull();
  });

  it('exact: whole-value equality only', () => {
    const { apply } = buildReplacer('kat', 'exact', 'cat');
    expect(apply('kat')).toBe('cat');
    expect(apply('kats')).toBeNull();
    expect(apply('Kat')).toBeNull();
  });

  it('regex: pattern verbatim with group references', () => {
    const { apply } = buildReplacer('([aeiou])h', 'regex', '$1:');
    expect(apply('ahbeh')).toBe('a:be:');
    expect(apply('xyz')).toBeNull();
  });

  it('a no-op rewrite is not a match', () => {
    const { apply } = buildReplacer('a', 'contains', 'a');
    expect(apply('banana')).toBeNull();
  });

  it('reports a bad regex instead of throwing', () => {
    const { apply, error } = buildReplacer('(', 'regex', 'x');
    expect(error).toBeTruthy();
    expect(apply('(')).toBeNull();
  });

  it('empty find never matches', () => {
    expect(buildReplacer('', 'contains', 'x').apply('anything')).toBeNull();
  });
});

describe('collectRespellRows / respellOps', () => {
  it('rows carry the token extent and only OWN morpheme forms that change', () => {
    const doc = docOf({
      body: 'kat kaka',
      words: [
        { id: 'w-1', begin: 0, end: 3 },
        { id: 'w-2', begin: 4, end: 8 },
      ],
      morphemes: [
        // w-1: single default morpheme, no own form — follows the baseline
        { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
        // w-2: split into two own forms
        { id: 'm-2', text: 'text-1', begin: 4, end: 8, precedence: 1, metadata: { form: 'ka' } },
        { id: 'm-3', text: 'text-1', begin: 4, end: 8, precedence: 2, metadata: { form: 'ka' } },
      ],
    });
    const { apply } = buildReplacer('k', 'contains', 'c');
    const rows = collectRespellRows(doc, apply);
    expect(rows.map((r) => [r.id, r.begin, r.end, r.old, r.new])).toEqual([
      ['w-1', 0, 3, 'kat', 'cat'],
      ['w-2', 4, 8, 'kaka', 'caca'],
    ]);
    expect(rows[0].morphemes).toEqual([]);
    expect(rows[1].morphemes).toEqual([
      { id: 'm-2', old: 'ka', new: 'ca' },
      { id: 'm-3', old: 'ka', new: 'ca' },
    ]);
    expect(rows[0].textId).toBe('text-1');
    expect(rows[0].docId).toBe('doc-1');
    expect(rows[0].text).toBe('kat kaka');
    expect(rows[0].marks).toEqual([{ begin: 0, end: 3 }]);
  });

  it('ops are whole-token replaces, highest offset first', () => {
    const doc = docOf({ body: 'kat kat' });
    const { apply } = buildReplacer('k', 'contains', 'c');
    const rows = collectRespellRows(doc, apply);
    expect(respellOps(rows)).toEqual([
      { type: 'replace', index: 4, length: 3, value: 'cat' },
      { type: 'replace', index: 0, length: 3, value: 'cat' },
    ]);
  });

  it('words that do not change produce no row', () => {
    const doc = docOf({ body: 'the cat' });
    const { apply } = buildReplacer('k', 'contains', 'c');
    expect(collectRespellRows(doc, apply)).toEqual([]);
  });

  it('lexicon rows come from every vocabulary', () => {
    const vocabs = {
      v1: {
        id: 'v1',
        name: 'Lex',
        items: [
          { id: 'i1', form: 'kat' },
          { id: 'i2', form: 'dog' },
        ],
      },
      v2: { id: 'v2', name: 'Other', items: [{ id: 'i3', form: 'kaka' }] },
    };
    const { apply } = buildReplacer('k', 'contains', 'c');
    expect(collectLexiconRows(vocabs, apply)).toEqual([
      { id: 'i1', kind: 'lexicon', vocabId: 'v1', vocabName: 'Lex', old: 'kat', new: 'cat' },
      { id: 'i3', kind: 'lexicon', vocabId: 'v2', vocabName: 'Other', old: 'kaka', new: 'caca' },
    ]);
  });
});

describe('collectFieldRows', () => {
  const raw = buildRawDoc({ body: 'the cat' });
  raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
    { id: 'sp-1', tokens: ['w-1'], value: 'DET' },
    { id: 'sp-2', tokens: ['w-2'], value: 'NOUN' },
  ];
  raw.textLayers[0].tokenLayers[2].spanLayers[0].spans = [
    { id: 'sp-3', tokens: ['m-2'], value: 'cat.NOUN' },
  ];
  raw.textLayers[0].tokenLayers[0].spanLayers[0].spans = [
    { id: 'sp-4', tokens: ['s-1'], value: 'The cat.' },
  ];
  raw.textLayers[0].tokenLayers[2].tokens[1].metadata = { form: 'cat' };
  const doc = new IgtDocument({ raw, client: makeFakeClient() });

  it('word-scoped spans', () => {
    const { apply } = buildReplacer('NOUN', 'exact', 'N');
    const rows = collectFieldRows(doc, { kind: 'span', scope: 'word', field: 'POS' }, apply);
    expect(rows.map((r) => [r.id, r.old, r.new, r.word])).toEqual([['sp-2', 'NOUN', 'N', 'cat']]);
    expect(rows[0].marks).toEqual([{ begin: 4, end: 7 }]);
  });

  it('morpheme-scoped spans', () => {
    const { apply } = buildReplacer('NOUN', 'contains', 'N');
    const rows = collectFieldRows(doc, { kind: 'span', scope: 'morpheme', field: 'Gloss' }, apply);
    expect(rows.map((r) => [r.id, r.old, r.new, r.word, r.morpheme])).toEqual([
      ['sp-3', 'cat.NOUN', 'cat.N', 'cat', 'cat'],
    ]);
  });

  it('sentence-scoped spans have no token marks', () => {
    const { apply } = buildReplacer('cat', 'contains', 'dog');
    const rows = collectFieldRows(
      doc,
      { kind: 'span', scope: 'sentence', field: 'Translation' },
      apply,
    );
    expect(rows.map((r) => [r.id, r.old, r.new])).toEqual([['sp-4', 'The cat.', 'The dog.']]);
    expect(rows[0].marks).toEqual([]);
  });

  it('morpheme forms: only own forms', () => {
    const { apply } = buildReplacer('t', 'contains', 'd');
    const rows = collectFieldRows(doc, { kind: 'morpheme' }, apply);
    // m-1 (under "the") has no own form and is skipped even though "the" has a t.
    expect(rows.map((r) => [r.id, r.kind, r.old, r.new])).toEqual([
      ['m-2', 'morphForm', 'cat', 'cad'],
    ]);
  });
});

describe('collectOccurrenceRows / tallyCandidates / analysisLabel', () => {
  const raw = buildRawDoc({
    body: 'kat kat kat',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
    ],
    morphemes: [
      { id: 'm-1', text: 'text-1', begin: 0, end: 3, precedence: 1, metadata: {} },
      { id: 'm-2', text: 'text-1', begin: 4, end: 7, precedence: 1, metadata: { form: 'ka' } },
      { id: 'm-3', text: 'text-1', begin: 4, end: 7, precedence: 2, metadata: { form: 't' } },
      { id: 'm-4', text: 'text-1', begin: 8, end: 11, precedence: 1, metadata: { form: 'ka' } },
      { id: 'm-5', text: 'text-1', begin: 8, end: 11, precedence: 2, metadata: { form: 't' } },
    ],
  });
  raw.textLayers[0].tokenLayers[2].spanLayers[0].spans = [
    { id: 'g-2', tokens: ['m-2'], value: 'cat' },
    { id: 'g-3', tokens: ['m-3'], value: 'PL' },
    { id: 'g-4', tokens: ['m-4'], value: 'cat' },
    { id: 'g-5', tokens: ['m-5'], value: 'PL' },
  ];
  raw.textLayers[0].tokenLayers[1].spanLayers[0].spans = [
    { id: 'p-3', tokens: ['w-3'], value: 'N' },
  ];
  const doc = new IgtDocument({ raw, client: makeFakeClient() });

  it('one row per exact occurrence, with the current analysis', () => {
    const rows = collectOccurrenceRows(doc, 'kat');
    expect(rows.map((r) => r.id)).toEqual(['w-1', 'w-2', 'w-3']);
    expect(rows[0].analysis).toBeNull();
    expect(rows[0].signature).toBeNull();
    expect(rows[1].analysis.morphemes.map((m) => m.form)).toEqual(['ka', 't']);
    // w-3 differs from w-2 only by its word-level POS
    expect(rows[1].signature).not.toBe(rows[2].signature);
  });

  it('candidates are the distinct analyses, most common first', () => {
    const rows = collectOccurrenceRows(doc, 'kat');
    const c = tallyCandidates(rows);
    expect(c.length).toBe(2);
    expect(c.every((x) => x.count === 1)).toBe(true);
    expect(analysisLabel(c[0].analysis)).toBe('ka-t · Gloss: cat-PL');
    expect(analysisLabel(rows[2].analysis)).toBe('ka-t · Gloss: cat-PL · POS: N');
    expect(analysisLabel(null)).toBe('(unanalyzed)');
  });

  it('labels name linked entries by form', () => {
    const a = {
      word: { vocabItemId: null, fields: {} },
      morphemes: [{ form: 'ka', morphType: null, vocabItemId: 'i1', fields: {} }],
    };
    expect(analysisLabel(a, new Map([['i1', 'ka₂']]))).toBe('ka · links: ka₂');
  });
});

describe('collectLinksToMove', () => {
  it('finds links to any losing item across vocabularies', () => {
    const doc = docOf({
      wordVocabs: [
        {
          id: 'v1',
          name: 'Lex',
          vocabLinks: [
            { id: 'l1', tokens: ['w-1'], vocabItem: { id: 'i1', form: 'the' } },
            { id: 'l2', tokens: ['w-2'], vocabItem: { id: 'i2', form: 'cat' }, metadata: { x: 1 } },
          ],
        },
      ],
      morphVocabs: [
        {
          id: 'v1',
          name: 'Lex',
          vocabLinks: [{ id: 'l3', tokens: ['m-2'], vocabItem: { id: 'i2', form: 'cat' } }],
        },
      ],
    });
    expect(collectLinksToMove(doc, ['i2'])).toEqual([
      { id: 'l2', itemId: 'i2', tokens: ['w-2'], metadata: { x: 1 }, docId: 'doc-1' },
      { id: 'l3', itemId: 'i2', tokens: ['m-2'], metadata: null, docId: 'doc-1' },
    ]);
  });
});

describe('groupByDoc', () => {
  it('keeps first-seen document order and sorts rows by sentence, then offset', () => {
    const rows = [
      { id: 'a', docId: 'd2', docName: 'Two', sentenceIndex: 1, hitBegin: 5 },
      { id: 'b', docId: 'd1', docName: 'One', sentenceIndex: 0, hitBegin: 9 },
      { id: 'c', docId: 'd2', docName: 'Two', sentenceIndex: 0, hitBegin: 0 },
      { id: 'd', docId: 'd1', docName: 'One', sentenceIndex: 0, hitBegin: 2 },
    ];
    expect(groupByDoc(rows).map((g) => [g.docName, g.rows.map((r) => r.id)])).toEqual([
      ['Two', ['c', 'a']],
      ['One', ['d', 'b']],
    ]);
  });
});
