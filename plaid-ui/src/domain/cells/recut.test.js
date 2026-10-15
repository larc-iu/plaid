import { describe, expect, it } from 'vitest';
import { neighboursAt, reshaped } from './recut.js';

const row = (text, before, after) => ({ text, before, after });

describe('reshaped', () => {
  it('a split leaves a prefix and a new row after, or a suffix and a new row before', () => {
    expect(reshaped(row('walked', 'a', 'b'), row('walk', 'a', 'new'))).toBe(true);
    expect(reshaped(row('walked', 'a', 'b'), row('ed', 'new', 'b'))).toBe(true);
  });
  it('a join or merge takes in the row on one side, which is gone', () => {
    expect(reshaped(row('the', 'a', 'b'), row('the cat', 'a', 'c'))).toBe(true);
    expect(reshaped(row('cat', 'b', 'c'), row('the cat', 'a', 'c'))).toBe(true);
    expect(reshaped(row('the', null, 'b'), row('the cat', null, null))).toBe(true);
  });
  it('a respelling keeps both neighbours', () => {
    expect(reshaped(row('walked', 'a', 'b'), row('walkd', 'a', 'b'))).toBe(false);
    expect(reshaped(row('rain', 'a', 'b'), row('rains', 'a', 'b'))).toBe(false);
  });
  it('a neighbour split or deleted, with this row respelled in the middle, is not a re-cut', () => {
    expect(reshaped(row('home today', 'a', 'b'), row('home, today', 'a2', 'b'))).toBe(false);
    expect(reshaped(row('barked', 'a', 'b'), row('barkd', 'a', 'c'))).toBe(false);
  });
  it('the same text is no re-cut whatever its neighbours', () => {
    expect(reshaped(row('dog', 'a', 'b'), row('dog', 'x', 'y'))).toBe(false);
    expect(reshaped(null, row('dog', 'x', 'y'))).toBe(false);
  });
});

describe('neighboursAt', () => {
  it('names the ids on either side, null at the ends', () => {
    const order = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(neighboursAt(order, 0)).toEqual({ before: null, after: 2 });
    expect(neighboursAt(order, 1)).toEqual({ before: 1, after: 3 });
    expect(neighboursAt(order, 2)).toEqual({ before: 2, after: null });
    expect(neighboursAt(order, -1)).toEqual({ before: null, after: null });
  });
});
