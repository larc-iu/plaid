import { describe, it, expect } from 'vitest';
import { sentenceNear } from './focusHandoff.js';

// The sentence a handoff between Analyze and Baseline lands on, by position:
// the one holding the offset, else the closest, else none.
describe('sentenceNear', () => {
  const sentences = [
    { id: 'a', begin: 0, end: 5 },
    { id: 'b', begin: 6, end: 10 },
    { id: 'c', begin: 20, end: 25 },
  ];
  const near = (at) => sentenceNear(sentences, at)?.id ?? null;

  it('takes the sentence holding the offset', () => {
    expect(near(0)).toBe('a');
    expect(near(6)).toBe('b');
    expect(near(24)).toBe('c');
  });

  it('takes a caret just after a sentence as in it', () => {
    expect(near(5)).toBe('a');
    expect(near(10)).toBe('b');
  });

  it('takes the closest sentence for an offset between sentences or past the last', () => {
    expect(near(13)).toBe('b');
    expect(near(18)).toBe('c');
    expect(near(99)).toBe('c');
  });

  it('is null for a document with no sentences', () => {
    expect(sentenceNear([], 3)).toBe(null);
    expect(sentenceNear(undefined, 3)).toBe(null);
  });
});
