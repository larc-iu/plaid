import { describe, expect, it } from 'vitest';
import { changedTo, recutTo } from './cellConflict.js';

describe('conflict toasts', () => {
  it('end with one period', () => {
    expect(changedTo('b', 'NOUN')).toBe('b changed this to NOUN.');
    expect(recutTo('b', 'si')).toBe('b changed this word to si.');
  });

  it('add no second period to a value that already ends a sentence', () => {
    expect(changedTo('b', 'He is tall.')).toBe('b changed this to He is tall.');
    expect(changedTo('b', 'Is he tall?')).toBe('b changed this to Is he tall?');
    expect(recutTo('b', 'We left.', 'sentence')).toBe('b changed this sentence to We left.');
  });

  it('names someone when no user is known, and says cleared for an empty value', () => {
    expect(changedTo(null, 'V')).toBe('Someone changed this to V.');
    expect(changedTo('b', '')).toBe('b cleared this.');
  });
});
