import { describe, it, expect } from 'vitest';
import { resolveFieldParams } from './serviceFields.js';

const SCHEMA = [
  { key: 'gloss_field', type: 'field', scope: 'Morpheme', role: 'gloss', default: '' },
  { key: 'translation_field', type: 'field', scope: 'Sentence', default: '' },
  { key: 'language', type: 'string', default: 'en' },
];

describe('resolveFieldParams', () => {
  it('keeps a value that names one of the fields', () => {
    const fields = { Morpheme: ['Gloss (pmy)', 'Gloss (en)'], Sentence: ['Translation'] };
    const values = { gloss_field: 'Gloss (en)', translation_field: 'Translation', language: 'x' };
    expect(resolveFieldParams(SCHEMA, values, fields)).toEqual(values);
  });

  it('fills a field parameter from the field whose stored Lexicon field holds its role', () => {
    const fields = { Morpheme: ['POS', 'Meaning'], Sentence: ['Translation'] };
    const fieldRoles = { Morpheme: { POS: 'pos', Meaning: 'gloss' } };
    expect(
      resolveFieldParams(SCHEMA, { gloss_field: '', translation_field: '' }, fields, fieldRoles),
    ).toMatchObject({ gloss_field: 'Meaning', translation_field: '' });
  });

  it('never picks a field by its name, or because it is the only one', () => {
    const fields = { Morpheme: ['Gloss (pmy)', 'POS'], Sentence: ['Translation (pmy)'] };
    const values = { gloss_field: 'Gloss', translation_field: 'Translation', language: 'x' };
    expect(resolveFieldParams(SCHEMA, values, fields)).toMatchObject({
      gloss_field: '',
      translation_field: '',
    });
  });

  it('leaves a choice between two paired fields for a person to make', () => {
    const fields = { Morpheme: ['Gloss (pmy)', 'Gloss (en)'], Sentence: [] };
    const fieldRoles = { Morpheme: { 'Gloss (pmy)': 'gloss', 'Gloss (en)': 'gloss' } };
    expect(resolveFieldParams(SCHEMA, { gloss_field: 'Gone' }, fields, fieldRoles)).toMatchObject({
      gloss_field: '',
    });
  });

  it('leaves alone a scope the app did not list, and everything without fields', () => {
    const values = { gloss_field: 'Gloss', translation_field: 'Gone' };
    expect(resolveFieldParams(SCHEMA, values, { Morpheme: ['Gloss'] })).toEqual(values);
    expect(resolveFieldParams(SCHEMA, values, null)).toBe(values);
  });
});
