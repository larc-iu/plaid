import { describe, it, expect } from 'vitest';

import { nfc, collationKey, compareNames, compareText, textIncludes } from './collation.js';

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

describe('compareNames', () => {
  const sorted = (names) => [...names].sort(compareNames);

  it('puts a numbered prefix in number order, whatever its shape', () => {
    expect(sorted(['(10) Frog story', '(2) Pear', '(1) Intro'])).toEqual([
      '(1) Intro',
      '(2) Pear',
      '(10) Frog story',
    ]);
    expect(sorted(['10. Ten', '2. Two', '1. One'])).toEqual(['1. One', '2. Two', '10. Ten']);
    expect(sorted(['Text 10', 'Text 2', 'Text 1'])).toEqual(['Text 1', 'Text 2', 'Text 10']);
    expect(sorted(['10_x', '02_x', '1_x'])).toEqual(['1_x', '02_x', '10_x']);
  });

  it('files unnumbered names among the letters, a blank name first', () => {
    expect(sorted(['Zebra', '(2) b', '', 'apple', '(10) a', 'Text 10', 'text 9'])).toEqual([
      '',
      '(2) b',
      '(10) a',
      'apple',
      'text 9',
      'Text 10',
      'Zebra',
    ]);
  });

  it('ignores case, and a tie falls to the names themselves', () => {
    expect(compareNames('apple', 'Banana')).toBeLessThan(0);
    // "02" and "2" are the same number: the strings decide, the same way
    // every time.
    expect(compareNames('02_x', '2_x')).toBeLessThan(0);
    expect(compareNames('2_x', '02_x')).toBeGreaterThan(0);
    expect(compareNames('Text', 'text')).toBeLessThan(0);
    expect(compareNames('Text', 'Text')).toBe(0);
  });

  it('counts digits of other scripts as numbers, and orders right-to-left names', () => {
    expect(sorted(['קובץ 10', 'קובץ 2'])).toEqual(['קובץ 2', 'קובץ 10']);
    // Arabic-Indic ١٠ is 10 and ٢ is 2.
    expect(sorted(['نص ١٠', 'نص ٢'])).toEqual(['نص ٢', 'نص ١٠']);
  });

  it('reads a missing name as blank and the two spellings of one name alike', () => {
    expect(compareNames(null, 'a')).toBeLessThan(0);
    expect(compareNames(undefined, '')).toBe(0);
    expect(compareNames(PRECOMPOSED, DECOMPOSED)).toBe(0);
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
