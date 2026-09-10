import { describe, it, expect } from 'vitest';
import { parseFieldName, fieldNameLang, resolveFieldLang } from './fieldNames.js';

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
