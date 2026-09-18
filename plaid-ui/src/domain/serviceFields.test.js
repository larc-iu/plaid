import { describe, it, expect } from 'vitest';
import { resolveFieldParams } from './serviceFields.js';

const SCHEMA = [
  { key: 'gloss_field', type: 'field', scope: 'Morpheme', default: 'Gloss' },
  { key: 'translation_field', type: 'field', scope: 'Sentence', default: 'Translation' },
  { key: 'language', type: 'string', default: 'en' },
];

describe('resolveFieldParams', () => {
  it('keeps a value that names one of the fields', () => {
    const fields = { Morpheme: ['Gloss (pmy)', 'Gloss (en)'], Sentence: ['Translation'] };
    const values = { gloss_field: 'Gloss (en)', translation_field: 'Translation', language: 'x' };
    expect(resolveFieldParams(SCHEMA, values, fields)).toEqual(values);
  });

  // A project whose fields each carry their language has no plain "Gloss".
  it('takes the one field a stale name begins', () => {
    const fields = { Morpheme: ['Gloss (pmy)', 'POS'], Sentence: ['Translation (pmy)', 'Note'] };
    const values = { gloss_field: 'Gloss', translation_field: 'Translation', language: 'x' };
    expect(resolveFieldParams(SCHEMA, values, fields)).toMatchObject({
      gloss_field: 'Gloss (pmy)',
      translation_field: 'Translation (pmy)',
    });
  });

  it('leaves a choice between two for a person to make', () => {
    const fields = { Morpheme: ['Gloss (pmy)', 'Gloss (en)'], Sentence: [] };
    expect(resolveFieldParams(SCHEMA, { gloss_field: 'Gloss' }, fields)).toMatchObject({
      gloss_field: '',
      translation_field: '',
    });
  });

  it("falls back to the scope's only field, and on the default when blank", () => {
    const fields = { Morpheme: ['Glosa'], Sentence: ['Translation', 'Note'] };
    expect(
      resolveFieldParams(SCHEMA, { gloss_field: 'Gone', translation_field: '' }, fields),
    ).toMatchObject({
      gloss_field: 'Glosa',
      translation_field: 'Translation',
    });
  });

  it('leaves alone a scope the app did not list, and everything without fields', () => {
    const values = { gloss_field: 'Gloss', translation_field: 'Gone' };
    expect(resolveFieldParams(SCHEMA, values, { Morpheme: ['Gloss'] })).toEqual(values);
    expect(resolveFieldParams(SCHEMA, values, null)).toBe(values);
  });
});
