import { describe, it, expect } from 'vitest';

import { nfc, collationKey, compareText, textIncludes } from './collation.js';

// `ẹja` written both ways: precomposed U+1EB9, and `e` with a combining dot
// below. A keyboard layout, a FLEx export and a paste out of a PDF each pick
// their own, and the two strings are not equal.
const PRECOMPOSED = 'ẹja';
const DECOMPOSED = 'ẹja';

describe('nfc', () => {
  it('gives the two spellings of one word the same string', () => {
    expect(PRECOMPOSED === DECOMPOSED).toBe(false);
    expect(nfc(DECOMPOSED)).toBe(PRECOMPOSED);
    expect(nfc(PRECOMPOSED)).toBe(PRECOMPOSED);
  });

  it('reads a missing value as empty', () => {
    expect(nfc(null)).toBe('');
    expect(nfc(undefined)).toBe('');
  });
});

describe('collationKey', () => {
  it('drops case after normalizing', () => {
    expect(collationKey('ẸJA')).toBe(PRECOMPOSED);
  });
});

describe('compareText', () => {
  it('files the two spellings of one word together', () => {
    // A collator folds canonical equivalence on its own, so this half was
    // never broken. `textIncludes` below is the half that was.
    expect(compareText(PRECOMPOSED, DECOMPOSED)).toBe(0);
  });

  it('files a marked letter with its letter, not after z', () => {
    expect(compareText(DECOMPOSED, 'ilé')).toBeLessThan(0);
    expect(compareText(DECOMPOSED, 'apple')).toBeGreaterThan(0);
  });

  it('counts a number as a number', () => {
    expect(compareText('a 9', 'a 10')).toBeLessThan(0);
  });
});

describe('textIncludes', () => {
  it('matches across normalizations, either way round', () => {
    expect(textIncludes(PRECOMPOSED, DECOMPOSED)).toBe(true);
    expect(textIncludes(DECOMPOSED, PRECOMPOSED)).toBe(true);
    expect(textIncludes(PRECOMPOSED, 'ẸJ')).toBe(true);
  });

  it('says no when the query is not there', () => {
    expect(textIncludes(PRECOMPOSED, 'oko')).toBe(false);
  });
});
