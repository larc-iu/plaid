import { describe, it, expect } from 'vitest';
import { parseFlexTierName, suggestFieldNames } from './tierNaming.js';

describe('parseFlexTierName', () => {
  it('splits a FieldWorks tier name into its item type and writing system', () => {
    expect(parseFlexTierName('Translation-gls-nl')).toEqual({
      base: 'Translation',
      itemType: 'gls',
      ws: 'nl',
    });
    expect(parseFlexTierName('Transcription-txt-oni')).toEqual({
      base: 'Transcription',
      itemType: 'txt',
      ws: 'oni',
    });
    expect(parseFlexTierName('Free-Translation-lit-en')).toEqual({
      base: 'Free-Translation',
      itemType: 'lit',
      ws: 'en',
    });
  });

  it('is null for a name that only looks the part', () => {
    // "title" is not a FLEx item type, so this is an ordinary tier name.
    expect(parseFlexTierName('interlinear-title-en')).toBeNull();
    expect(parseFlexTierName('Translation-gls-something')).toBeNull(); // not a tag
    expect(parseFlexTierName('Translation')).toBeNull();
    expect(parseFlexTierName('gls-nl')).toBeNull(); // no base
    expect(parseFlexTierName('')).toBeNull();
  });
});

describe('suggestFieldNames', () => {
  // The reporter's project: three translation fields, the primary one bare.
  const existing = {
    Sentence: [
      { name: 'Translation', id: 'f1' },
      { name: 'Translation (en)', id: 'f2' },
      { name: 'Translation (nl)', id: 'f3' },
    ],
    Word: [{ name: 'Gloss', id: 'f4' }],
    Morpheme: [],
  };
  const entry = (key, name, scope = 'Sentence') => ({ key, name, scope });

  it('pairs by writing system and deduces the bare field for the one left over', () => {
    expect(
      suggestFieldNames(
        [
          entry('k1', 'Translation-gls-en'),
          entry('k2', 'Translation-gls-nl'),
          entry('k3', 'Translation-gls-pmy'),
        ],
        existing,
      ),
    ).toEqual({
      k1: 'Translation (en)',
      k2: 'Translation (nl)',
      k3: 'Translation', // pmy is the primary, which is why it has no tag
    });
  });

  it('matches on what a field records, ahead of what its name looks like', () => {
    // The project was told: "Translation" is pmy. No elimination needed, and it
    // holds even where the names alone would have made a different pairing.
    const recorded = { 'Sentence:Translation': 'pmy', 'Sentence:Translation (en)': 'en' };
    expect(
      suggestFieldNames(
        [entry('k1', 'Translation-gls-pmy'), entry('k2', 'Translation-gls-en')],
        existing,
        recorded,
      ),
    ).toEqual({ k1: 'Translation', k2: 'Translation (en)' });
  });

  it('pairs an unlabelled tier even where another field is labelled', () => {
    // "Translation" says it is pmy, so the id tier cannot take it, and the two
    // that remain are matched by their tags.
    const recorded = { 'Sentence:Translation': 'pmy' };
    expect(
      suggestFieldNames(
        [entry('k1', 'Translation-gls-id'), entry('k2', 'Translation-gls-nl')],
        existing,
        recorded,
      ),
    ).toEqual({ k2: 'Translation (nl)' });
  });

  it('leaves the bare field alone when more than one tier could claim it', () => {
    const out = suggestFieldNames(
      [entry('k1', 'Translation-gls-pmy'), entry('k2', 'Translation-gls-id')],
      existing,
    );
    expect(out).toEqual({}); // two candidates for one field: no guess
  });

  it('does not pair across scopes or across different fields', () => {
    expect(suggestFieldNames([entry('k1', 'Translation-gls-en', 'Word')], existing)).toEqual({});
    expect(suggestFieldNames([entry('k1', 'Note-note-en')], existing)).toEqual({});
  });

  it('matches a word-scope tier against the word fields', () => {
    expect(suggestFieldNames([entry('k1', 'Gloss-gls-pmy', 'Word')], existing)).toEqual({
      k1: 'Gloss',
    });
  });

  it('ignores tiers whose names are not FieldWorks-shaped', () => {
    expect(suggestFieldNames([entry('k1', 'interlinear-title-en')], existing)).toEqual({});
  });
});
