import { describe, it, expect } from 'vitest';
import {
  precedentGuessSource,
  vocabEntryGuessSource,
  defaultGuessSource,
  PRECEDENT_SOURCE,
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
