// Tokenizer punctuation handling. Convention (shared with the .fwbackup
// import): ignored break chars — non-whitelisted punctuation, or chars in a
// blacklist — are NOT emitted as tokens. They're left in the gap between word
// tokens, so the word layer carries only annotatable words.
import { describe, it, expect } from 'vitest';
import { findUntokenizedRanges, isUnicodePunctuation, tokenizeText } from './tokenizationUtils.js';

const tokenize = (text, config) => tokenizeText(text, config, findUntokenizedRanges(text, []));

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

// The token-boundary rule is a curated one, not \p{P}, and the curation was
// never written down — which is how two wrong code points sat in it unnoticed.
// These pin the parts that a plausible "cleanup" would silently change.
describe('isUnicodePunctuation', () => {
  it('breaks on ordinary punctuation', () => {
    for (const c of ['.', ',', '!', '?', ';', ':', '-', '(', ')', '«', '¿', '।']) {
      expect(isUnicodePunctuation(c)).toBe(true);
    }
  });

  it('breaks on the keyboard symbols too, which \\p{P} alone would drop', () => {
    // 24 characters hang on this. "=" is the clitic marker, so losing it would
    // change how every document tokenizes.
    for (const c of ['=', '+', '<', '>', '$', '^', '`', '|', '~', '¢', '£', '¥']) {
      expect(isUnicodePunctuation(c)).toBe(true);
    }
  });

  it('does not break on letters, digits or whitespace', () => {
    for (const c of ['a', 'Z', 'ß', 'д', '漢', '5', ' ']) {
      expect(isUnicodePunctuation(c)).toBe(false);
    }
  });

  it('does not break on a combining mark or a letter, whatever the script', () => {
    // U+111C9 (Sharada Sandhi Mark, Mn) and U+111DA (Sharada Ekam, Lo) were
    // both in the class. A combining mark cannot stand alone as punctuation,
    // and eslint's no-misleading-character-class is what caught it.
    expect(isUnicodePunctuation('\u{111C9}')).toBe(false);
    expect(isUnicodePunctuation('\u{111DA}')).toBe(false);
    expect(isUnicodePunctuation('́')).toBe(false); // combining acute
  });

  it('rejects anything that is not exactly one code point', () => {
    expect(isUnicodePunctuation('')).toBe(false);
    expect(isUnicodePunctuation('..')).toBe(false);
    expect(isUnicodePunctuation(null)).toBe(false);
  });
});
