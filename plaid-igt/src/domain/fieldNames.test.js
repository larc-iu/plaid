import { describe, it, expect } from 'vitest';
import { parseFieldName, fieldNameLang } from './fieldNames.js';

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
