import { describe, it, expect } from 'vitest';
import { filterVocabItems, fieldEmpty, fieldText, ANY_FIELD } from './vocabItemFilter.js';

const items = [
  { id: 'a', form: 'perro', metadata: { gloss: 'dog', pos: 'n', morphType: 'stem' } },
  { id: 'b', form: 'gato', metadata: { gloss: 'cat', pos: 'n' } },
  { id: 'c', form: '-s', metadata: { gloss: 'PL', morphType: 'suffix' } },
  { id: 'd', form: 'correr', metadata: { pos: 'v', gloss: '   ' } },
  { id: 'e', form: 'dog' },
];
const fieldNames = ['morphType', 'gloss', 'pos'];
const ids = (list) => list.map((it) => it.id);

describe('filterVocabItems', () => {
  it('returns every entry for an empty query', () => {
    expect(ids(filterVocabItems(items, { fieldNames }))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(filterVocabItems(items, { query: '   ', fieldNames }))).toEqual(ids(items));
  });

  it('searches the form and every field, case-insensitively', () => {
    expect(ids(filterVocabItems(items, { query: 'DOG', fieldNames }))).toEqual(['a', 'e']);
    expect(ids(filterVocabItems(items, { query: 'n', field: ANY_FIELD, fieldNames }))).toEqual([
      'a',
      'b',
    ]);
  });

  it('scoped to a field, searches that field alone', () => {
    expect(ids(filterVocabItems(items, { query: 'dog', field: 'gloss', fieldNames }))).toEqual([
      'a',
    ]);
    expect(ids(filterVocabItems(items, { query: 'dog', field: 'form', fieldNames }))).toEqual([
      'e',
    ]);
    expect(ids(filterVocabItems(items, { query: 'v', field: 'pos', fieldNames }))).toEqual(['d']);
  });

  it('matches a morph type by the label the table shows, not the stored code', () => {
    expect(
      ids(filterVocabItems(items, { query: 'suffix', field: 'morphType', fieldNames })),
    ).toEqual(['c']);
    expect(ids(filterVocabItems(items, { query: 'suffix', fieldNames }))).toEqual(['c']);
  });

  it('with emptyOnly, keeps the entries with no value in the field', () => {
    expect(ids(filterVocabItems(items, { field: 'gloss', emptyOnly: true, fieldNames }))).toEqual([
      'd',
      'e',
    ]);
    expect(ids(filterVocabItems(items, { field: 'pos', emptyOnly: true, fieldNames }))).toEqual([
      'c',
      'e',
    ]);
  });

  it('with emptyOnly, the query reads the form, since the field has nothing to read', () => {
    expect(
      ids(filterVocabItems(items, { query: 'do', field: 'gloss', emptyOnly: true, fieldNames })),
    ).toEqual(['e']);
    expect(
      ids(filterVocabItems(items, { query: 'corr', field: 'gloss', emptyOnly: true, fieldNames })),
    ).toEqual(['d']);
  });

  it('never treats the form as empty, since every entry has one', () => {
    expect(ids(filterVocabItems(items, { field: 'form', emptyOnly: true, fieldNames }))).toEqual(
      [],
    );
    expect(fieldEmpty(items[4], 'form')).toBe(false);
    expect(fieldEmpty(items[3], 'gloss')).toBe(true);
  });

  it('reads a field as the text the table shows', () => {
    expect(fieldText(items[0], 'form')).toBe('perro');
    expect(fieldText(items[0], 'gloss')).toBe('dog');
    expect(fieldText(items[2], 'morphType')).toBe('suffix');
    expect(fieldText(items[4], 'gloss')).toBe('');
  });
});
