import { describe, expect, it } from 'vitest';
import { isTokenIgnored } from './igtConfig.js';
import {
  PICTOGRAPHIC,
  PUNCT_OR_SYMBOL,
  isPictograph,
  isPunctOrSymbol,
} from './punctuationClasses.js';

const PUNCT = { type: 'unicodePunctuation', whitelist: [] };

const runtimeRanges = (re) => {
  const out = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (!re.test(String.fromCodePoint(cp))) continue;
    const last = out[out.length - 1];
    if (last && last[1] === cp - 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
};

describe('the ignored-token character classes', () => {
  it('answer from the pinned table, whatever Unicode the runtime has', () => {
    // A pictograph in Unicode 16 and not in 17: a word in every browser.
    expect(isPictograph('★')).toBe(true);
    expect(isTokenIgnored('★', PUNCT)).toBe(false);
    // New in Unicode 16 (Garay hyphen): ignored even where the runtime is older.
    expect(isPunctOrSymbol('\u{10d6e}')).toBe(true);
    expect(isTokenIgnored('\u{10d6e}', PUNCT)).toBe(true);
    expect(isTokenIgnored('.', PUNCT)).toBe(true);
    expect(isTokenIgnored('😀', PUNCT)).toBe(false);
    expect(isPunctOrSymbol('')).toBe(false);
    expect(isPictograph('a')).toBe(false);
  });

  it.runIf(process.versions.unicode === '16.0')(
    'are what tools/punctuationClasses.mjs writes from a Unicode 16 runtime',
    () => {
      expect(PUNCT_OR_SYMBOL).toEqual(runtimeRanges(/[\p{P}\p{S}]/u));
      expect(PICTOGRAPHIC).toEqual(runtimeRanges(/\p{Extended_Pictographic}/u));
    },
  );
});
