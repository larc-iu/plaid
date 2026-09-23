import { describe, it, expect } from 'vitest';
import { fieldPruneWrites } from './vocabFieldPrune.js';
import { FIELD_TYPES } from './vocabFields.js';

// Changing a field's type rewrites values already in it, and a vocabulary entry
// has no history to restore from, so what these hold onto is that a write names
// the ONE field it changes and nothing else, and that a value the new type
// cannot hold comes out as an explicit delete op rather than as an absent key
// (which would leave it there).

const text = (name) => ({ name, type: FIELD_TYPES.TEXT, many: false });
const one = (name) => ({ name, type: FIELD_TYPES.ITEM, many: false });
const many = (name) => ({ name, type: FIELD_TYPES.ITEM, many: true });

describe('fieldPruneWrites', () => {
  it('deletes the field when it stops being an Entry field', () => {
    const items = [
      { id: 'a', form: 'a', metadata: { seeAlso: 'b', gloss: 'keep me' } },
      { id: 'b', form: 'b', metadata: {} },
    ];
    expect(fieldPruneWrites(items, text('seeAlso'))).toEqual([
      { id: 'a', metadata: [{ op: 'delete', path: ['seeAlso'] }] },
    ]);
  });

  it('keeps a reference that resolves when the field becomes an Entry field', () => {
    const items = [
      { id: 'a', form: 'a', metadata: { seeAlso: 'b' } },
      { id: 'b', form: 'b', metadata: {} },
    ];
    expect(fieldPruneWrites(items, one('seeAlso'))).toEqual([]);
  });

  it('deletes a reference to an entry that is gone', () => {
    const items = [{ id: 'a', form: 'a', metadata: { seeAlso: 'ghost' } }];
    expect(fieldPruneWrites(items, one('seeAlso'))).toEqual([
      { id: 'a', metadata: [{ op: 'delete', path: ['seeAlso'] }] },
    ]);
  });

  it('drops an entry pointing at itself', () => {
    const items = [{ id: 'a', form: 'a', metadata: { seeAlso: 'a' } }];
    expect(fieldPruneWrites(items, one('seeAlso'))).toEqual([
      { id: 'a', metadata: [{ op: 'delete', path: ['seeAlso'] }] },
    ]);
  });

  // A single-reference field keeps the first id, so a list becomes that id.
  it('reshapes a list onto a single-reference field', () => {
    const items = [
      { id: 'a', form: 'a', metadata: { seeAlso: ['b', 'c'] } },
      { id: 'b', form: 'b', metadata: {} },
      { id: 'c', form: 'c', metadata: {} },
    ];
    expect(fieldPruneWrites(items, one('seeAlso'))).toEqual([
      { id: 'a', metadata: [{ op: 'set', path: ['seeAlso'], value: 'b' }] },
    ]);
  });

  it('reshapes a single id onto a list field', () => {
    const items = [
      { id: 'a', form: 'a', metadata: { seeAlso: 'b' } },
      { id: 'b', form: 'b', metadata: {} },
    ];
    expect(fieldPruneWrites(items, many('seeAlso'))).toEqual([
      { id: 'a', metadata: [{ op: 'set', path: ['seeAlso'], value: ['b'] }] },
    ]);
  });

  it('keeps the ids that resolve out of a list and deletes nothing else', () => {
    const items = [
      { id: 'a', form: 'a', metadata: { seeAlso: ['b', 'ghost'], gloss: 'x' } },
      { id: 'b', form: 'b', metadata: {} },
    ];
    expect(fieldPruneWrites(items, many('seeAlso'))).toEqual([
      { id: 'a', metadata: [{ op: 'set', path: ['seeAlso'], value: ['b'] }] },
    ]);
  });

  it('leaves an entry with nothing in the field alone', () => {
    const items = [
      { id: 'a', form: 'a', metadata: {} },
      { id: 'b', form: 'b', metadata: { seeAlso: '' } },
      { id: 'c', form: 'c', metadata: { seeAlso: null } },
    ];
    expect(fieldPruneWrites(items, text('seeAlso'))).toEqual([]);
  });

  it('takes an empty vocabulary and a field with no name', () => {
    expect(fieldPruneWrites([], text('x'))).toEqual([]);
    expect(fieldPruneWrites(null, text('x'))).toEqual([]);
    expect(fieldPruneWrites([{ id: 'a', metadata: { x: 'y' } }], {})).toEqual([]);
  });
});
