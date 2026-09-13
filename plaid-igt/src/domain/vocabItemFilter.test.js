import { describe, it, expect } from 'vitest';
import {
  filterVocabItems,
  sortVocabItems,
  fieldEmpty,
  fieldText,
  ANY_FIELD,
} from './vocabItemFilter.js';

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

  it('reads a field through textOf when one is given', () => {
    // What an Entry field holds is an id; what the screen shows is the entry
    // it names, and that is what the box searches.
    const refs = [
      { id: 'r1', form: 'kat', metadata: {} },
      { id: 'r2', form: 'katt', metadata: { variantOf: 'r1' } },
    ];
    const textOf = (item, field) =>
      field === 'variantOf' ? (item.metadata.variantOf === 'r1' ? 'kat' : '') : (item.form ?? '');
    expect(
      ids(filterVocabItems(refs, { query: 'kat', field: 'variantOf', fieldNames: [], textOf })),
    ).toEqual(['r2']);
    // Without it the id is all there is to match, and nothing does.
    expect(ids(filterVocabItems(refs, { query: 'kat', field: 'variantOf' }))).toEqual([]);
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

describe('sortVocabItems', () => {
  const rows = [
    { id: 'p2', form: 'perro', metadata: { gloss: 'hound' } },
    { id: 'g', form: 'Gato', metadata: { gloss: 'cat' } },
    { id: 'p1', form: 'perro', metadata: { gloss: 'dog' } },
    { id: 'x', form: 'ave' },
  ];
  const numbers = new Map([
    ['p1', '1'],
    ['p2', '2'],
  ]);
  const usageCounts = { p1: 3, g: 10, x: 0 };
  const ids = (list) => list.map((it) => it.id);

  it('sorts by form, case-insensitively, entries alike in number order', () => {
    expect(ids(sortVocabItems(rows, { key: 'form', dir: 'asc' }, { numbers }))).toEqual([
      'x',
      'g',
      'p1',
      'p2',
    ]);
    expect(ids(sortVocabItems(rows, { key: 'form', dir: 'desc' }, { numbers }))).toEqual([
      'p2',
      'p1',
      'g',
      'x',
    ]);
  });

  it('sorts by gloss, with the unglossed last either way', () => {
    expect(ids(sortVocabItems(rows, { key: 'gloss', dir: 'asc' }, { numbers }))).toEqual([
      'g',
      'p1',
      'p2',
      'x',
    ]);
    expect(ids(sortVocabItems(rows, { key: 'gloss', dir: 'desc' }, { numbers }))).toEqual([
      'p2',
      'p1',
      'g',
      'x',
    ]);
  });

  it('sorts by uses, an unknown count as zero, ties by form', () => {
    expect(
      ids(sortVocabItems(rows, { key: 'uses', dir: 'desc' }, { numbers, usageCounts })),
    ).toEqual(['g', 'p1', 'x', 'p2']);
    expect(
      ids(sortVocabItems(rows, { key: 'uses', dir: 'asc' }, { numbers, usageCounts })),
    ).toEqual(['x', 'p2', 'p1', 'g']);
  });

  it('falls back to the form for an unknown column, and never mutates its input', () => {
    const copy = [...rows];
    expect(ids(sortVocabItems(rows, { key: 'nope', dir: 'asc' }, { numbers }))).toEqual([
      'x',
      'g',
      'p1',
      'p2',
    ]);
    expect(rows).toEqual(copy);
  });
});

describe('sortVocabItems and letters outside ASCII', () => {
  const items = [
    { id: '1', form: 'ẹja' },
    { id: '2', form: 'zebra' },
    { id: '3', form: 'ilé' },
    { id: '4', form: 'ọkọ' },
    { id: '5', form: 'apple' },
  ];

  it('files a marked letter with its letter, not after z', () => {
    // Comparing the strings with `<` is code-point order, which put ẹ (U+1EB9)
    // and ọ (U+1ECD) after every ASCII letter: a Yoruba lexicon showed them
    // below the end of the alphabet.
    const forms = sortVocabItems(items, { key: 'form', dir: 'asc' }, new Map()).map((i) => i.form);
    expect(forms.indexOf('ẹja')).toBeLessThan(forms.indexOf('ilé'));
    expect(forms.indexOf('ọkọ')).toBeLessThan(forms.indexOf('zebra'));
    expect(forms[0]).toBe('apple');
    expect(forms.at(-1)).toBe('zebra');
  });

  it('files a decomposed form where its precomposed twin goes', () => {
    // `ẹ` written `e` + U+0323 sorts where `ẹja` does. The sort has always got
    // this right, because a collator folds canonical equivalence itself. The
    // search box below did not, which is the half that broke.
    const mixed = [
      { id: '1', form: 'ẹja' },
      { id: '2', form: 'egun' },
      { id: '3', form: 'ẹran' },
    ];
    const forms = sortVocabItems(mixed, { key: 'form', dir: 'asc' }).map((i) => i.form);
    expect(forms).toEqual(['egun', 'ẹja', 'ẹran']);
  });

  it('finds a decomposed form from a precomposed query, and back', () => {
    const mixed = [
      { id: '1', form: 'ẹja' },
      { id: '2', form: 'ẹran' },
    ];
    expect(filterVocabItems(mixed, { query: 'ẹja' }).map((i) => i.id)).toEqual(['1']);
    expect(filterVocabItems(mixed, { query: 'ẹran' }).map((i) => i.id)).toEqual(['2']);
  });
});
