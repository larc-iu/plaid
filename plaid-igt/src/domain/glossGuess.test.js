import { describe, it, expect } from 'vitest';
import {
  precedentGuessSource,
  vocabEntryGuessSource,
  defaultGuessSource,
  listAlternatives,
  allowedGuess,
  PRECEDENT_SOURCE,
  TAGSET_SOURCE,
} from './glossGuess.js';
import { createTally, foldDocumentValues } from './precedent.js';

const sent = (tokens) => [{ tokens }];
const word = (content, annotations = {}, morphemes = []) => ({
  content,
  annotations: Object.fromEntries(Object.entries(annotations).map(([k, v]) => [k, { value: v }])),
  morphemes,
});
const morph = (form, annotations = {}, metadata = null) => ({
  metadata: { form },
  annotations: Object.fromEntries(
    Object.entries(annotations).map(([k, v]) => [k, { value: v, metadata }]),
  ),
});
// The editor's tally for a document with these fields.
const tallyOf = (sentences, fields) => foldDocumentValues(createTally(), sentences, fields);

describe('precedentGuessSource', () => {
  it('guesses the value used by same-form morphemes', () => {
    const g = precedentGuessSource(
      tallyOf(
        sent([word('perros', {}, [morph('perro', { Gloss: 'dog' }), morph('s', { Gloss: 'PL' })])]),
        { morphFields: ['Gloss'] },
      ),
    );
    expect(g.guessFor('morpheme', 's', 'Gloss')).toEqual({ value: 'PL', source: PRECEDENT_SOURCE });
    expect(g.guessFor('morpheme', 'perro', 'Gloss')).toEqual({
      value: 'dog',
      source: PRECEDENT_SOURCE,
    });
    expect(g.guessFor('morpheme', 'gato', 'Gloss')).toBeNull();
  });

  it('picks the most frequent value and refuses ties', () => {
    const g = precedentGuessSource(
      tallyOf(
        sent([
          word('a', {}, [
            morph('s', { Gloss: 'PL' }),
            morph('s', { Gloss: 'PL' }),
            morph('s', { Gloss: '3SG' }),
          ]),
          word('b', {}, [morph('la', { Gloss: 'DEF' }), morph('la', { Gloss: '3SG.F' })]),
        ]),
        { morphFields: ['Gloss'] },
      ),
    );
    expect(g.guessFor('morpheme', 's', 'Gloss')?.value).toBe('PL'); // 2 vs 1
    expect(g.guessFor('morpheme', 'la', 'Gloss')).toBeNull(); // 1 vs 1 tie
  });

  it('keeps word and morpheme namespaces separate and skips empty values', () => {
    const g = precedentGuessSource(
      tallyOf(
        sent([
          word('se', { POS: 'PRON' }, [morph('se', { Gloss: '' })]),
          word('se', { POS: 'PRON' }),
        ]),
        { wordFields: ['POS'], morphFields: ['Gloss'] },
      ),
    );
    expect(g.guessFor('word', 'se', 'POS')?.value).toBe('PRON');
    expect(g.guessFor('morpheme', 'se', 'Gloss')).toBeNull(); // empty value never counted
    expect(g.guessFor('morpheme', 'se', 'POS')).toBeNull(); // kind-scoped
  });

  it('guesses from unverified machine-made values too (adopting is a human act, ruling A1-11)', () => {
    const machine = { prov: 'inferred', provSource: 'service:x' };
    const verified = { ...machine, provConfirmed: true };
    const g = precedentGuessSource(
      tallyOf(
        sent([
          word('a', {}, [
            morph('s', { Gloss: 'PL' }, machine),
            morph('s', { Gloss: 'PL' }, machine),
          ]),
          word('b', {}, [morph('la', { Gloss: 'DEF' }, verified)]),
        ]),
        { morphFields: ['Gloss'] },
      ),
    );
    expect(g.guessFor('morpheme', 's', 'Gloss')?.value).toBe('PL');
    expect(g.guessFor('morpheme', 'la', 'Gloss')?.value).toBe('DEF');
  });
});

describe('vocabEntryGuessSource', () => {
  const g = vocabEntryGuessSource();
  const ctx = (metadata) => ({ vocabItem: { metadata } });

  it("offers the linked entry's same-named field, matching across case and separators", () => {
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ gloss: 'dog' }))).toEqual({
      value: 'dog',
      source: 'vocab:entry',
    });
    expect(g.guessFor('word', 'perro', 'POS', ctx({ pos: 'N' }))?.value).toBe('N');
    expect(g.guessFor('word', 'x', 'Morph Type', ctx({ morphType: 'stem' }))?.value).toBe('stem');
  });

  it('has no opinion for unlinked tokens, unknown fields, or blank entry values', () => {
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: null })).toBeNull();
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ pos: 'N' }))).toBeNull();
    expect(g.guessFor('morpheme', 'perro', 'Gloss', ctx({ gloss: '  ' }))).toBeNull();
  });
});

describe('defaultGuessSource', () => {
  it('prefers the linked entry over precedent, and falls back to it', () => {
    const g = defaultGuessSource({
      precedent: tallyOf(
        sent([
          word('perros', {}, [morph('perro', { Gloss: 'hound' }), morph('s', { Gloss: 'PL' })]),
        ]),
        { morphFields: ['Gloss'] },
      ),
    });
    const item = { metadata: { gloss: 'dog' } };
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: item })?.value).toBe('dog');
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: null })?.value).toBe('hound');
    expect(g.guessFor('morpheme', 's', 'Gloss', { vocabItem: { metadata: {} } })).toEqual({
      value: 'PL',
      source: PRECEDENT_SOURCE,
    });
  });
});

describe('listAlternatives', () => {
  const precedent = tallyOf(
    sent([
      word('a', {}, [
        morph('s', { Gloss: 'PL' }),
        morph('s', { Gloss: 'PL' }),
        morph('s', { Gloss: '3SG' }, { prov: 'inferred', provSource: 'service:x' }),
      ]),
    ]),
    { morphFields: ['Gloss'] },
  );

  it('merges precedent counts, the linked entry and the producer distribution, ranked', () => {
    const list = listAlternatives({
      precedent,
      kind: 'morpheme',
      form: 's',
      field: 'Gloss',
      vocabItem: { metadata: { gloss: '3SG' } },
      span: {
        metadata: {
          prov: 'inferred',
          provSource: 'service:x',
          provDetail: { value: 'PL', valueProbs: { PL: 0.7, GEN: 0.2, '3SG': 0.1 } },
        },
      },
    });
    expect(list.map((r) => [r.value, r.count, r.prob, r.entry, r.model, r.source])).toEqual([
      ['PL', 2, 0.7, false, true, PRECEDENT_SOURCE],
      ['3SG', 1, 0.1, true, true, 'vocab:entry'],
      ['GEN', 0, 0.2, false, true, 'service:x'],
    ]);
  });

  it('is empty when nothing is known, and precedent alone ranks by count then name', () => {
    expect(listAlternatives({ precedent, kind: 'morpheme', form: 'zzz', field: 'Gloss' })).toEqual(
      [],
    );
    const t = tallyOf(
      sent([word('a', {}, [morph('la', { Gloss: 'DEF' }), morph('la', { Gloss: '3SG.F' })])]),
      { morphFields: ['Gloss'] },
    );
    expect(
      listAlternatives({ precedent: t, kind: 'morpheme', form: 'la', field: 'Gloss' }).map(
        (r) => r.value,
      ),
    ).toEqual(['3SG.F', 'DEF']);
  });
});

describe('listAlternatives with a tagset', () => {
  const tagset = (over = {}) => ({
    delimiters: '',
    closed: false,
    values: [{ value: 'PL', description: 'plural' }, { value: 'SG' }],
    ...over,
  });

  // "s" has been glossed PL twice and GEN once in this document.
  const precedent = tallyOf(
    sent([
      word('a', {}, [morph('s', { Gloss: 'PL' })]),
      word('b', {}, [morph('s', { Gloss: 'PL' })]),
      word('c', {}, [morph('s', { Gloss: 'GEN' })]),
    ]),
    { morphFields: ['Gloss'] },
  );
  const list = (over = {}) =>
    listAlternatives({ precedent, kind: 'morpheme', form: 's', field: 'Gloss', ...over });

  it('offers the tagset even where there is no precedent at all', () => {
    const rows = list({ form: 'zzz', tagset: tagset() });
    expect(rows.map((r) => [r.value, r.count, r.source])).toEqual([
      ['PL', 0, TAGSET_SOURCE],
      ['SG', 0, TAGSET_SOURCE],
    ]);
  });

  it('an attested tagset value keeps its count and picks up the description', () => {
    const rows = list({ tagset: tagset() });
    const pl = rows.find((r) => r.value === 'PL');
    expect([pl.count, pl.source, pl.description]).toEqual([2, PRECEDENT_SOURCE, 'plural']);
  });

  it('an OPEN tagset still offers off-tagset precedent', () => {
    expect(list({ tagset: tagset() }).map((r) => r.value)).toEqual(['PL', 'GEN', 'SG']);
  });

  it('a CLOSED tagset drops off-tagset precedent, since committing it would fail', () => {
    expect(list({ tagset: tagset({ closed: true }) }).map((r) => r.value)).toEqual(['PL', 'SG']);
  });

  it('delimiters switch the list to parts, pooling counts across whole values', () => {
    // 1SG.NOM twice and 1SG.ERG once: 1SG outranks either whole value.
    const t = tallyOf(
      sent([
        word('a', {}, [morph('m', { Gloss: '1SG.NOM' })]),
        word('b', {}, [morph('m', { Gloss: '1SG.NOM' })]),
        word('c', {}, [morph('m', { Gloss: '1SG.ERG' })]),
      ]),
      { morphFields: ['Gloss'] },
    );
    const rows = listAlternatives({
      precedent: t,
      kind: 'morpheme',
      form: 'm',
      field: 'Gloss',
      tagset: { delimiters: '.', closed: false, values: [] },
    });
    expect(rows.map((r) => [r.value, r.count])).toEqual([
      ['1SG', 3],
      ['NOM', 2],
      ['ERG', 1],
    ]);
  });

  it('a closed part-mode tagset keeps only its own parts', () => {
    const t = tallyOf(sent([word('a', {}, [morph('m', { Gloss: '1SG.ABL' })])]), {
      morphFields: ['Gloss'],
    });
    const rows = listAlternatives({
      precedent: t,
      kind: 'morpheme',
      form: 'm',
      field: 'Gloss',
      tagset: { delimiters: '.', closed: true, values: [{ value: '1SG' }, { value: 'NOM' }] },
    });
    expect(rows.map((r) => [r.value, r.count])).toEqual([
      ['1SG', 1],
      ['NOM', 0],
    ]);
  });

  it('behaves exactly as before when there is no tagset', () => {
    expect(list().map((r) => [r.value, r.count])).toEqual([
      ['PL', 2],
      ['GEN', 1],
    ]);
  });
});

describe('allowedGuess', () => {
  const closed = { delimiters: '.', closed: true, values: [{ value: 'PL' }] };

  it('passes a guess the tagset allows', () => {
    const g = { value: 'PL', source: PRECEDENT_SOURCE };
    expect(allowedGuess(g, closed)).toBe(g);
  });

  it('drops one it does not, so Enter never adopts what commit would reject', () => {
    expect(allowedGuess({ value: 'GEN', source: PRECEDENT_SOURCE }, closed)).toBeNull();
  });

  it('passes everything when the field has no tagset', () => {
    const g = { value: 'anything', source: PRECEDENT_SOURCE };
    expect(allowedGuess(g, null)).toBe(g);
  });
});
