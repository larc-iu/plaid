import { describe, it, expect } from 'vitest';
import { igtWordCount } from './igtWordCount.js';

describe('igtWordCount', () => {
  const doc = (tokens) => ({
    body: 'Ana runs... home.',
    layerInfo: {
      primaryTokenLayer: {
        config: { igt: { ignoredTokens: { type: 'unicodePunctuation', whitelist: [] } } },
        tokens,
      },
    },
  });
  const words = [
    { begin: 0, end: 3 },
    { begin: 4, end: 8 },
    { begin: 12, end: 16 },
  ];
  it('counts words the same with and without punctuation tokens', () => {
    const punct = [
      { begin: 8, end: 11 },
      { begin: 16, end: 17 },
    ];
    expect(igtWordCount(doc(words))).toBe(3);
    expect(igtWordCount(doc([...words, ...punct]))).toBe(3);
  });
});
