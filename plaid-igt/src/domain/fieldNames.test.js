import { describe, it, expect, vi } from 'vitest';

// `withLangSuffix` is watched rather than replaced: every call runs the real
// one, so the rest of this file tests the module itself, and a writer that
// spells the bracket by hand instead can still be told apart from one that
// goes through it.
const { wroteSuffix } = vi.hoisted(() => ({ wroteSuffix: vi.fn() }));
vi.mock('./fieldNames.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withLangSuffix: (...args) => {
      wroteSuffix(...args);
      return actual.withLangSuffix(...args);
    },
  };
});

const { parseFieldName, fieldNameLang, resolveFieldLang, withLangSuffix } = await import(
  './fieldNames.js'
);
const { fieldLabel } = await import('./vocabFields.js');

describe('parseFieldName', () => {
  it('splits a writing-system suffix off the base', () => {
    expect(parseFieldName('gloss')).toEqual({ base: 'gloss', ws: null });
    expect(parseFieldName('gloss (ru)')).toEqual({ base: 'gloss', ws: 'ru' });
    expect(parseFieldName('Note (old) (fr)')).toEqual({ base: 'Note (old)', ws: 'fr' });
    expect(parseFieldName('')).toEqual({ base: '', ws: null });
  });
});

describe('fieldNameLang', () => {
  it('reads a language tag out of the name', () => {
    expect(fieldNameLang('Gloss (nl)')).toBe('nl');
    expect(fieldNameLang('Translation (pmy)')).toBe('pmy');
    expect(fieldNameLang('Gloss (spa-x-translit)')).toBe('spa-x-translit');
  });

  it('is null for a bare name or a suffix that is not a tag', () => {
    expect(fieldNameLang('Translation')).toBeNull();
    expect(fieldNameLang('Translation (free)')).toBeNull();
    expect(fieldNameLang('Gloss (broad)')).toBeNull();
    expect(fieldNameLang('Note (1)')).toBeNull();
  });
});

// The writers and the reader are one pair: every importer that puts a
// language in a field's name goes through withLangSuffix (FLEx's fields,
// titles, abbreviations and lexicon keys; CLDF's translations; ELAN's tiers),
// and fieldNameLang reads it back.
describe('withLangSuffix', () => {
  it('writes a name fieldNameLang reads the tag back out of', () => {
    for (const [base, tag] of [
      ['Gloss', 'nl'],
      ['Translation', 'pmy'],
      ['Title', 'spa-x-translit'],
    ]) {
      expect(fieldNameLang(withLangSuffix(base, tag))).toBe(tag);
      expect(parseFieldName(withLangSuffix(base, tag)).base).toBe(base);
    }
  });

  it('keeps a base that already carries a bracket', () => {
    expect(parseFieldName(withLangSuffix('Note (old)', 'fr'))).toEqual({
      base: 'Note (old)',
      ws: 'fr',
    });
  });

  // The label a vocabulary field is SHOWN under is not its name (the base is
  // humanized), but the bracket in it is the same bracket, so a label reads
  // back the same way a name does.
  it('writes the language in a vocabulary field label too', () => {
    wroteSuffix.mockClear();
    expect(fieldLabel({ name: 'gloss', lang: 'pt' })).toBe('Gloss (pt)');
    expect(wroteSuffix).toHaveBeenCalledWith('Gloss', 'pt');
    expect(fieldNameLang(fieldLabel({ name: 'gloss', lang: 'pt' }))).toBe('pt');
  });

  it('is not asked when the label says the language already', () => {
    wroteSuffix.mockClear();
    expect(fieldLabel({ name: 'gloss (en)', lang: 'en' })).toBe('Gloss (en)');
    expect(fieldLabel('morphType')).toBe('Morph Type');
    expect(wroteSuffix).not.toHaveBeenCalled();
  });
});

// The record is the fact and the name is how it arrived: a field named
// "Gloss (nl)" whose record says otherwise goes out under the record, and
// renaming a field cannot change the language its values go out under.
describe('resolveFieldLang', () => {
  const langs = {
    overrides: { POS: 'en' },
    fieldLangs: { 'Morpheme:Gloss (nl)': 'nld' },
    analysis: 'pmy',
  };

  it('prefers the preset override, then the record, then the analysis tag', () => {
    expect(resolveFieldLang(langs, 'Word', 'POS')).toBe('en');
    expect(resolveFieldLang(langs, 'Morpheme', 'Gloss (nl)')).toBe('nld');
    expect(resolveFieldLang(langs, 'Morpheme', 'Gloss')).toBe('pmy');
  });

  it('never reads the language out of the name', () => {
    expect(resolveFieldLang({ analysis: 'pmy' }, 'Sentence', 'Translation (nl)')).toBe('pmy');
  });

  it('is blank, not English, when nothing says', () => {
    expect(resolveFieldLang({}, 'Sentence', 'Translation')).toBe('');
  });
});
