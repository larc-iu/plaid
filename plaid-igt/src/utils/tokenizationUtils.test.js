// Tokenizer punctuation handling. Convention (shared with the .fwbackup
// import): ignored break chars — non-whitelisted punctuation, or chars in a
// blacklist — are NOT emitted as tokens. They're left in the gap between word
// tokens, so the word layer carries only annotatable words.
import { describe, it, expect } from 'vitest';
import { findUntokenizedRanges, tokenizeText } from './tokenizationUtils.js';

const tokenize = (text, config) =>
  tokenizeText(text, config, findUntokenizedRanges(text, []));

describe('tokenizeText punctuation handling', () => {
  const punctCfg = { type: 'unicodePunctuation', whitelist: [] };

  it('leaves punctuation in gaps rather than emitting tokens', () => {
    expect(tokenize('hello, world.', punctCfg)).toEqual([
      { text: 'hello', begin: 0, end: 5 },
      { text: 'world', begin: 7, end: 12 },
    ]);
  });

  it('does not split words on whitelisted punctuation', () => {
    const cfg = { type: 'unicodePunctuation', whitelist: ["'", '-'] };
    expect(tokenize("don't well-known", cfg)).toEqual([
      { text: "don't", begin: 0, end: 5 },
      { text: 'well-known', begin: 6, end: 16 },
    ]);
  });

  it('emits no tokens for a run of punctuation between words', () => {
    // "a ... b": the "..." run produces zero tokens (it becomes one gap when
    // pieces are derived from token coverage), not three throwaway tokens.
    expect(tokenize('a ... b', punctCfg)).toEqual([
      { text: 'a', begin: 0, end: 1 },
      { text: 'b', begin: 6, end: 7 },
    ]);
  });

  it('handles punctuation with no surrounding whitespace', () => {
    expect(tokenize('abc,def', punctCfg)).toEqual([
      { text: 'abc', begin: 0, end: 3 },
      { text: 'def', begin: 4, end: 7 },
    ]);
  });

  it('blacklist mode skips blacklisted break chars too', () => {
    const cfg = { type: 'blacklist', blacklist: ['|'] };
    expect(tokenize('a|b', cfg)).toEqual([
      { text: 'a', begin: 0, end: 1 },
      { text: 'b', begin: 2, end: 3 },
    ]);
  });
});
