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
  // A change of text with a neighbour new or gone counts as a re-cut, which
  // errs toward not writing (REV-UI-1).
  it('a respelling made while a neighbour was split or deleted reads as a re-cut', () => {
    expect(reshaped(row('home today', 'a', 'b'), row('home, today', 'a2', 'b'))).toBe(true);
    expect(reshaped(row('barked', 'a', 'b'), row('barkd', 'a', 'c'))).toBe(true);
  });
  // REV-UI-1: real splits and merges whose kept text is not a prefix or
  // suffix of the old one.
  for (const [label, was, now] of [
    ['a split whose kept part is also re-cased', row('thedog', 'a', 'b'), row('The', 'a', 'n')],
    [
      'a split whose kept part is also respelled',
      row('dogsbarkd', 'a', 'b'),
      row('dogs', 'a', 'n'),
    ],
    ['a split respelled at the cut', row('walkedhome', 'a', 'b'), row('walked,', 'a', 'n')],
    ['a split in three, the id kept on the middle', row('abc', 'a', 'b'), row('b', 'n1', 'n2')],
    [
      'a sentence split with a period typed at the cut',
      row('the dog barked and the cat ran', null, 's2'),
      row('the dog barked.', null, 'new'),
    ],
    [
      'a sentence merge by deleting the period',
      row('the dog barked.', null, 's2'),
      row('the dog barked and the cat ran.', null, 's3'),
    ],
    ['an RTL split', row('وكتب', 'a', 'b'), row('و', 'a', 'n')],
    ['a split before a combining mark', row('cafés', 'a', 'b'), row('cafe', 'a', 'n')],
  ]) {
    it(`${label} is a re-cut`, () => {
      expect(reshaped(was, now)).toBe(true);
    });
  }
  it('a respelling that adds or drops a letter or a combining mark at an end keeps both neighbours', () => {
    expect(reshaped(row('walked', 'a', 'b'), row('walke', 'a', 'b'))).toBe(false);
    expect(reshaped(row('alked', 'a', 'b'), row('walked', 'a', 'b'))).toBe(false);
    expect(reshaped(row('cafe', 'a', 'b'), row('café', 'a', 'b'))).toBe(false);
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
