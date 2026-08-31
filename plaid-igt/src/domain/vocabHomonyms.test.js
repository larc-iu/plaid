import { describe, it, expect } from 'vitest';
import { buildHomonymIndex } from './vocabHomonyms.js';

const item = (id, form) => ({ id, form });
const ranks = (items) => {
  const index = buildHomonymIndex(items);
  return items.map((it) => index.get(it.id));
};

describe('buildHomonymIndex', () => {
  it('leaves a form that occurs once unnumbered', () => {
    expect(ranks([item('a', 'ktab'), item('b', 'qhen')])).toEqual([null, null]);
  });

  it('numbers homonyms 1..n in the order given', () => {
    expect(ranks([item('a', 'ktab'), item('b', 'qhen'), item('c', 'ktab')])).toEqual([1, null, 2]);
  });

  // The bug this function shipped with. It sorted each group by id, believing
  // UUIDv7 ids sort into creation order. Within one bulk write they share a
  // millisecond and the rest is random, so ids routinely descend as items
  // ascend. Numbering must follow the array, never the ids.
  it('numbers by position even when the ids sort the other way', () => {
    const items = [item('zzz', 'ktab'), item('mmm', 'ktab'), item('aaa', 'ktab')];
    expect(ranks(items)).toEqual([1, 2, 3]);
  });

  it('gives a later homonym the next number without renumbering the earlier ones', () => {
    const before = [item('a', 'ktab'), item('b', 'ktab')];
    const after = [...before, item('c', 'ktab')];
    expect(ranks(before)).toEqual([1, 2]);
    expect(ranks(after)).toEqual([1, 2, 3]);
  });

  it('groups by exact form, so differing forms never share a series', () => {
    const items = [item('a', 'ktab'), item('b', 'Ktab'), item('c', 'ktab')];
    expect(ranks(items)).toEqual([1, null, 2]);
  });

  it('tolerates an empty list, a missing list, and items with no form', () => {
    expect(buildHomonymIndex([]).size).toBe(0);
    expect(buildHomonymIndex(undefined).size).toBe(0);
    // Two items with no form are homonyms of each other (both ''), which is
    // what the table shows while a new entry is being typed.
    expect(ranks([{ id: 'a' }, { id: 'b' }])).toEqual([1, 2]);
  });
});
