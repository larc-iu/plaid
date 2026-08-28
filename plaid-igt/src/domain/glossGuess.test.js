import { describe, it, expect } from 'vitest';
import {
  docFrequencyGuessSource,
  vocabEntryGuessSource,
  defaultGuessSource,
} from './glossGuess.js';

const sent = (tokens) => [{ tokens }];
const word = (content, annotations = {}, morphemes = []) => ({
  content,
  annotations: Object.fromEntries(Object.entries(annotations).map(([k, v]) => [k, { value: v }])),
  morphemes,
});
const morph = (form, annotations = {}) => ({
  metadata: { form },
  annotations: Object.fromEntries(Object.entries(annotations).map(([k, v]) => [k, { value: v }])),
});

describe('docFrequencyGuessSource', () => {
  it('guesses the value used by same-form morphemes', () => {
    const g = docFrequencyGuessSource(
      sent([word('perros', {}, [morph('perro', { Gloss: 'dog' }), morph('s', { Gloss: 'PL' })])]),
      { morphFields: ['Gloss'] },
    );
    expect(g.guessFor('morpheme', 's', 'Gloss')).toEqual({
      value: 'PL',
      source: 'gloss:doc-frequency',
    });
    expect(g.guessFor('morpheme', 'perro', 'Gloss')).toEqual({
      value: 'dog',
      source: 'gloss:doc-frequency',
    });
    expect(g.guessFor('morpheme', 'gato', 'Gloss')).toBeNull();
  });

  it('picks the most frequent value and refuses ties', () => {
    const g = docFrequencyGuessSource(
      sent([
        word('a', {}, [
          morph('s', { Gloss: 'PL' }),
          morph('s', { Gloss: 'PL' }),
          morph('s', { Gloss: '3SG' }),
        ]),
        word('b', {}, [morph('la', { Gloss: 'DEF' }), morph('la', { Gloss: '3SG.F' })]),
      ]),
      { morphFields: ['Gloss'] },
    );
    expect(g.guessFor('morpheme', 's', 'Gloss')?.value).toBe('PL'); // 2 vs 1
    expect(g.guessFor('morpheme', 'la', 'Gloss')).toBeNull(); // 1 vs 1 tie
  });

  it('keeps word and morpheme namespaces separate and skips empty values', () => {
    const g = docFrequencyGuessSource(
      sent([
        word('se', { POS: 'PRON' }, [morph('se', { Gloss: '' })]),
        word('se', { POS: 'PRON' }),
      ]),
      { wordFields: ['POS'], morphFields: ['Gloss'] },
    );
    expect(g.guessFor('word', 'se', 'POS')?.value).toBe('PRON');
    expect(g.guessFor('morpheme', 'se', 'Gloss')).toBeNull(); // empty value never counted
    expect(g.guessFor('morpheme', 'se', 'POS')).toBeNull(); // kind-scoped
  });
});

describe('vocabEntryGuessSource', () => {
  const g = vocabEntryGuessSource();
  const item = { id: 'i1', form: 'perro', metadata: { gloss: 'dog', pos: 'N', morphType: 'stem' } };

  it("offers the linked entry's same-named field, matching across case and separators", () => {
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: item })).toEqual({
      value: 'dog',
      source: 'vocab:entry',
    });
    expect(g.guessFor('word', 'perro', 'POS', { vocabItem: item })?.value).toBe('N');
    expect(g.guessFor('morpheme', 'perro', 'Morph Type', { vocabItem: item })?.value).toBe('stem');
  });

  it('has no opinion for unlinked tokens, unknown fields, or blank entry values', () => {
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: null })).toBeNull();
    expect(g.guessFor('morpheme', 'perro', 'Gloss')).toBeNull();
    expect(g.guessFor('morpheme', 'perro', 'Note', { vocabItem: item })).toBeNull();
    const blank = { metadata: { gloss: '  ' } };
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: blank })).toBeNull();
  });
});

describe('defaultGuessSource', () => {
  it('prefers the linked entry over document frequency, and falls back to it', () => {
    const g = defaultGuessSource(
      sent([word('perros', {}, [morph('perro', { Gloss: 'hound' }), morph('s', { Gloss: 'PL' })])]),
      { morphFields: ['Gloss'] },
    );
    const item = { metadata: { gloss: 'dog' } };
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: item })?.value).toBe('dog');
    expect(g.guessFor('morpheme', 'perro', 'Gloss', { vocabItem: null })?.value).toBe('hound');
    expect(g.guessFor('morpheme', 's', 'Gloss', { vocabItem: { metadata: {} } })).toEqual({
      value: 'PL',
      source: 'gloss:doc-frequency',
    });
  });
});
