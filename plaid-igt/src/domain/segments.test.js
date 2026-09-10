import { describe, it, expect } from 'vitest';
import { segmentText, segmentsWithText, splitPointsFromSegments } from './segments.js';

const seg = (id, begin, end) => ({ id, begin, end });

describe('segmentsWithText', () => {
  // "the cat saw the dog": segments over "the cat" (0-7), nothing (7-7),
  // whitespace only (7-8), and "the dog" (12-19).
  const body = 'the cat saw the dog';
  const tokens = [seg('a', 0, 7), seg('b', 7, 7), seg('c', 7, 8), seg('d', 12, 19)];

  it('finds the segments with no text, whitespace counting as none', () => {
    expect(segmentsWithText(tokens, body, '').map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('finds the segments whose text is exactly the value, trimmed on both sides', () => {
    expect(segmentsWithText(tokens, body, ' the dog ').map((t) => t.id)).toEqual(['d']);
    expect(segmentsWithText(tokens, body, 'the')).toEqual([]);
  });

  it('reads a segment as its own stretch of the baseline', () => {
    expect(segmentText(body, seg('x', 8, 12))).toBe('saw');
  });
});

describe('splitPointsFromSegments', () => {
  // One sentence over the whole body, words at every space.
  const body = 'the cat saw the dog';
  const sentences = [{ id: 's', begin: 0, end: body.length }];
  const words = [
    [0, 3],
    [4, 7],
    [8, 11],
    [12, 15],
    [16, 19],
  ].map(([b, e], i) => ({ id: `w${i}`, begin: b, end: e }));

  it('takes each segment start inside a sentence, in order, once', () => {
    const alignments = [seg('a', 12, 19), seg('b', 8, 11), seg('c', 8, 11), seg('d', 0, 7)];
    expect(splitPointsFromSegments({ sentences, words, alignments })).toEqual({
      positions: [8, 12],
      insideWord: 0,
    });
  });

  it('skips a start where a sentence already begins, and one outside every sentence', () => {
    const two = [
      { id: 's1', begin: 0, end: 8 },
      { id: 's2', begin: 8, end: 19 },
    ];
    const alignments = [seg('a', 8, 11), seg('b', 25, 30)];
    expect(splitPointsFromSegments({ sentences: two, words, alignments }).positions).toEqual([]);
  });

  it('skips a start inside a word and counts it', () => {
    const alignments = [seg('a', 5, 7), seg('b', 12, 19)];
    expect(splitPointsFromSegments({ sentences, words, alignments })).toEqual({
      positions: [12],
      insideWord: 1,
    });
  });
});
