import { describe, it, expect } from 'vitest';
import { planVocabReplace, replaceWrites } from './vocabReplace.js';
import { buildReplacer } from './replacer.js';

const items = [
  { id: 'a', form: 'perro', metadata: { gloss: 'dog', pos: 'n' } },
  { id: 'b', form: 'perra', metadata: { gloss: 'dog (f)', pos: 'n' } },
  { id: 'c', form: 'gato', metadata: { gloss: 'cat', pos: 'noun' } },
  { id: 'd', form: 'x', metadata: {} },
];
const itemsById = new Map(items.map((it) => [it.id, it]));
const closedPos = {
  name: 'POS',
  mode: 'closed',
  delimiters: '',
  values: [{ value: 'n' }, { value: 'v' }],
};

describe('planVocabReplace', () => {
  it('lists the entries the substitution changes, with old and new', () => {
    const { apply } = buildReplacer('dog', 'contains', 'hound');
    expect(planVocabReplace(items, { field: 'gloss', apply })).toEqual([
      { id: 'a', form: 'perro', old: 'dog', new: 'hound', invalid: null },
      { id: 'b', form: 'perra', old: 'dog (f)', new: 'hound (f)', invalid: null },
    ]);
  });

  it('replaces in the form', () => {
    const { apply } = buildReplacer('^perr', 'regex', 'Perr');
    expect(planVocabReplace(items, { field: 'form', apply }).map((r) => r.new)).toEqual([
      'Perro',
      'Perra',
    ]);
  });

  it('flags a replacement that would empty the form', () => {
    const { apply } = buildReplacer('x', 'exact', '');
    expect(planVocabReplace(items, { field: 'form', apply })).toEqual([
      { id: 'd', form: 'x', old: 'x', new: '', invalid: 'empty' },
    ]);
  });

  it('flags a value an enforcing tagset refuses, and only then', () => {
    const { apply } = buildReplacer('n', 'exact', 'noun');
    expect(planVocabReplace(items, { field: 'pos', apply, tagset: closedPos })).toEqual([
      { id: 'a', form: 'perro', old: 'n', new: 'noun', invalid: 'tagset' },
      { id: 'b', form: 'perra', old: 'n', new: 'noun', invalid: 'tagset' },
    ]);
    const suggest = { ...closedPos, mode: 'suggest' };
    expect(
      planVocabReplace(items, { field: 'pos', apply, tagset: suggest }).map((r) => r.invalid),
    ).toEqual([null, null]);
    const { apply: toN } = buildReplacer('noun', 'exact', 'n');
    expect(planVocabReplace(items, { field: 'pos', apply: toN, tagset: closedPos })).toEqual([
      { id: 'c', form: 'gato', old: 'noun', new: 'n', invalid: null },
    ]);
  });
});

describe('replaceWrites', () => {
  it('writes a form change as the trimmed new form', () => {
    const rows = [{ id: 'a', form: 'perro', old: 'perro', new: ' Perro ', invalid: null }];
    expect(replaceWrites(rows, { field: 'form', itemsById })).toEqual([{ id: 'a', form: 'Perro' }]);
  });

  it('writes a field change as the whole metadata, so nothing else is lost', () => {
    const rows = [{ id: 'a', form: 'perro', old: 'dog', new: 'hound', invalid: null }];
    expect(replaceWrites(rows, { field: 'gloss', itemsById })).toEqual([
      { id: 'a', metadata: { gloss: 'hound', pos: 'n' } },
    ]);
  });

  it('drops the key when the replacement empties the value', () => {
    const rows = [{ id: 'a', form: 'perro', old: 'dog', new: '', invalid: null }];
    expect(replaceWrites(rows, { field: 'gloss', itemsById })).toEqual([
      { id: 'a', metadata: { pos: 'n' } },
    ]);
  });

  it('never writes an invalid row, even when it was chosen', () => {
    const rows = [
      { id: 'a', form: 'perro', old: 'n', new: 'noun', invalid: 'tagset' },
      { id: 'd', form: 'x', old: 'x', new: '', invalid: 'empty' },
    ];
    expect(replaceWrites(rows, { field: 'pos', itemsById })).toEqual([]);
    expect(replaceWrites(rows, { field: 'form', itemsById })).toEqual([]);
  });
});
