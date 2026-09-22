import { describe, it, expect } from 'vitest';
import { fieldWorksFieldNames, parseFlexTierName, suggestFieldNames } from './tierNaming.js';
import { fieldNameLang } from '../../domain/fieldNames.js';

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

describe('fieldWorksFieldNames', () => {
  const entry = (key, name) => ({ key, name });

  // As the FLEx importer names the same fields: a code on every one once there
  // is more than one language, and none with one.
  it('tags every field when the tiers are in more than one language', () => {
    expect(
      fieldWorksFieldNames([
        entry('k1', 'Translation-gls-pmy'),
        entry('k2', 'Translation-gls-en'),
        entry('k3', 'Participant-note-en'),
      ]),
    ).toEqual({ k1: 'Translation (pmy)', k2: 'Translation (en)', k3: 'Participant (en)' });
  });

  it('leaves the code off when there is one language', () => {
    expect(
      fieldWorksFieldNames([entry('k1', 'Translation-gls-pmy'), entry('k2', 'Gloss-gls-pmy')]),
    ).toEqual({ k1: 'Translation', k2: 'Gloss' });
  });

  // Joining a project whose fields are in en, a pmy tier is one of several.
  it("counts the languages a project's fields are in already", () => {
    expect(fieldWorksFieldNames([entry('k1', 'Translation-gls-pmy')], ['en'])).toEqual({
      k1: 'Translation (pmy)',
    });
    expect(fieldWorksFieldNames([entry('k1', 'Translation-gls-pmy')], ['pmy', null])).toEqual({
      k1: 'Translation',
    });
  });

  // FLEx writes a text's free translation as `-gls-` and its literal one as
  // `-lit-`, with one base between them.
  it('tells two tiers of one base apart by their item code', () => {
    expect(
      fieldWorksFieldNames([entry('k1', 'Translation-gls-en'), entry('k2', 'Translation-lit-en')]),
    ).toEqual({ k1: 'Translation', k2: 'Literal Translation' });
    expect(
      fieldWorksFieldNames([
        entry('k1', 'Translation-gls-en'),
        entry('k2', 'Translation-lit-en'),
        entry('k3', 'Translation-gls-pmy'),
      ]),
    ).toEqual({
      k1: 'Translation (en)',
      k2: 'Literal Translation (en)',
      k3: 'Translation (pmy)',
    });
  });

  it('names nothing that is not FieldWorks-shaped', () => {
    expect(fieldWorksFieldNames([entry('k1', 'ft'), entry('k2', 'Gloss')])).toEqual({});
  });

  // A field name's parenthesized suffix is its WRITING SYSTEM. FLEx's own
  // ELAN export writes a `-pos-` word tier beside the `-txt-` one, and the
  // two share a base, so the item code used to go in the brackets: "Word
  // (pos)" reads back as a field in the language `pos`, which the next
  // document open records on the layer and both FLEx exporters then tag its
  // values with.
  it('never puts a FLEx item code where a language tag is read', () => {
    const named = fieldWorksFieldNames([
      entry('k1', 'Word-txt-oni'),
      entry('k2', 'Word-pos-oni'),
      entry('k3', 'Morph-msa-oni'),
      entry('k4', 'Morph-cf-oni'),
      entry('k5', 'Morph-hn-oni'),
      entry('k6', 'Morph-punct-oni'),
    ]);
    expect(named).toEqual({
      k1: 'Word Text',
      k2: 'Word POS',
      k3: 'Morph Morphosyntax',
      k4: 'Morph Citation Form',
      k5: 'Morph Homograph Number',
      k6: 'Morph Punctuation',
    });
    for (const name of Object.values(named)) expect(fieldNameLang(name)).toBeNull();
  });

  it('still tags the language when the codes and the languages both differ', () => {
    const named = fieldWorksFieldNames([entry('k1', 'Word-txt-oni'), entry('k2', 'Word-pos-en')]);
    expect(named).toEqual({ k1: 'Word Text (oni)', k2: 'Word POS (en)' });
    expect(fieldNameLang(named.k1)).toBe('oni');
    expect(fieldNameLang(named.k2)).toBe('en');
  });
});
