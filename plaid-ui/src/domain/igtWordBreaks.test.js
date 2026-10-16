import { describe, expect, it } from 'vitest';
import {
  isIgnoredCharacter,
  isTokenIgnored,
  isUnicodePunctuation,
  shouldTokenizeCharacter,
} from './igtWordBreaks.js';

const PUNCT = { type: 'unicodePunctuation', whitelist: [] };
const LETTER_LIKE = { type: 'unicodePunctuation', whitelist: ["'", '=', '-'] };
const LIST = { type: 'blacklist', blacklist: ['.', '--'] };

// Characters a word breaks at that IGT still reads as a word on their own:
// pictographs (© ® ‼ ⁉ 〰 〽) and the soft hyphen (Cf, neither P nor S). Another
// app's Tokenize leaves them as text, as IGT does (REV7-IGT-2).
const BREAK_NOT_IGNORED = ['©', '­', '®', '‼', '⁉', '〰', '〽'];

describe('which characters IGT ignores', () => {
  it('is punctuation and symbols, minus pictographs, the zero morph and letter-like ones', () => {
    for (const c of ['.', ',', '«', '»', '¿', '(', '…', '=', '—']) {
      expect(isIgnoredCharacter(c, PUNCT)).toBe(true);
    }
    for (const c of ['a', 'ʼ', '∅', '😀', '★', ' ', '0']) {
      expect(isIgnoredCharacter(c, PUNCT)).toBe(false);
    }
    expect(isIgnoredCharacter("'", LETTER_LIKE)).toBe(false);
    expect(isIgnoredCharacter('.', LETTER_LIKE)).toBe(true);
  });

  it('is no single character under an explicit list or no rule', () => {
    expect(isIgnoredCharacter('.', LIST)).toBe(false);
    expect(isIgnoredCharacter('.', null)).toBe(false);
    expect(isTokenIgnored('.', LIST)).toBe(true);
    expect(isTokenIgnored('--', LIST)).toBe(true);
    expect(isTokenIgnored('-', LIST)).toBe(false);
    expect(isTokenIgnored('.', null)).toBe(false);
  });

  it('reads a token as ignored when every character is', () => {
    expect(isTokenIgnored('?!', PUNCT)).toBe(true);
    expect(isTokenIgnored('.x', PUNCT)).toBe(false);
    expect(isTokenIgnored("'", LETTER_LIKE)).toBe(false);
    expect(isTokenIgnored("'.", LETTER_LIKE)).toBe(false);
  });

  it('leaves out the characters a word breaks at but IGT reads as words', () => {
    for (const c of BREAK_NOT_IGNORED) {
      expect(isUnicodePunctuation(c)).toBe(true);
      expect(shouldTokenizeCharacter(c, PUNCT)).toBe(true);
      expect(isIgnoredCharacter(c, PUNCT)).toBe(false);
      expect(isTokenIgnored(c, PUNCT)).toBe(false);
    }
  });
});
