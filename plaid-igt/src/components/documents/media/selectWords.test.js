import { describe, it, expect } from 'vitest';
import { snapToWords } from './selectWords.js';

const T = 'the quick brown fox';

describe('snapToWords', () => {
  it('keeps a selection that already sits on word boundaries', () => {
    expect(snapToWords(T, 4, 15)).toEqual({ start: 4, end: 15 });
  });

  it('grows a selection that starts or ends inside a word to the whole word', () => {
    expect(snapToWords(T, 6, 13)).toEqual({ start: 4, end: 15 }); // "uick brow"
    expect(snapToWords(T, 0, 1)).toEqual({ start: 0, end: 3 }); // "t"
    expect(snapToWords(T, 18, 19)).toEqual({ start: 16, end: 19 }); // "x"
  });

  it('drops the whitespace at either end', () => {
    expect(snapToWords(T, 3, 16)).toEqual({ start: 4, end: 15 }); // " quick brown "
  });

  it('takes the offsets in either order, as a backwards drag reports them', () => {
    expect(snapToWords(T, 15, 4)).toEqual({ start: 4, end: 15 });
  });

  it('is null for a caret or for whitespace alone', () => {
    expect(snapToWords(T, 5, 5)).toBeNull();
    expect(snapToWords('a  b', 1, 3)).toBeNull();
    expect(snapToWords('', 0, 0)).toBeNull();
  });

  it('clamps offsets to the text', () => {
    expect(snapToWords(T, -3, 50)).toEqual({ start: 0, end: 19 });
  });

  it('treats a newline as a word break', () => {
    expect(snapToWords('one\ntwo', 1, 5)).toEqual({ start: 0, end: 7 });
  });
});
