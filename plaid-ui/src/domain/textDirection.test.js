import { describe, it, expect } from 'vitest';
import { applyMetadataOps } from '@larc-iu/plaid-client';

import {
  AUTO,
  LTR,
  RTL,
  detectDirection,
  readTextDirection,
  resolveDirection,
  textDirectionOps,
  withTextDirection,
} from './textDirection.js';

// Real data, not lorem: each of these is the kind of string that actually
// reaches the detector.
const ARABIC = 'قرأ الولد الكتاب في المدرسة';
const HEBREW = 'הילד קרא את הספר';
const PERSIAN = 'پسر کتاب را در مدرسه خواند';
const THAANA = 'ދަރިވަރު ފޮތް ކިޔެވި';
const NKO = 'ߒߞߏ ߞߊ߲ ߘߏ߫ ߟߋ߬';
const ADLAM = '𞤀𞤣𞤤𞤢𞤥 𞤢𞤲𞥋𞤣𞤭';
const ENGLISH = 'The boy read the book at school';

describe('detectDirection', () => {
  it('reads an RTL script as RTL, whichever one it is', () => {
    for (const s of [ARABIC, HEBREW, PERSIAN, THAANA, NKO, ADLAM]) {
      expect(detectDirection(s)).toBe(RTL);
    }
  });

  it('reads Latin as LTR', () => {
    expect(detectDirection(ENGLISH)).toBe(LTR);
  });

  it('is not swung by the first word', () => {
    // The case first-strong gets wrong, and the reason this counts instead: a
    // transcript that opens with a speaker's name, or with a loanword left in
    // the source script.
    expect(detectDirection(`Ahmad: ${ARABIC}`)).toBe(RTL);
    expect(detectDirection(`${ARABIC} (radio)`)).toBe(RTL);
    expect(detectDirection(`${ENGLISH}, glossed as كتاب`)).toBe(LTR);
  });

  it('ignores digits and punctuation, in either script', () => {
    // Arabic-Indic digits are Script=Arabic and say nothing about direction.
    expect(detectDirection('١٢٣٤٥ 12345 ... !')).toBe(LTR);
    expect(detectDirection('')).toBe(LTR);
    expect(detectDirection('   ')).toBe(LTR);
  });

  it('reads a missing value as LTR rather than throwing', () => {
    expect(detectDirection(null)).toBe(LTR);
    expect(detectDirection(undefined)).toBe(LTR);
  });

  it('breaks a tie towards LTR', () => {
    expect(detectDirection('abc دعو')).toBe(LTR);
  });

  it('counts combining marks as neither', () => {
    // Arabic diacritics are marks, not letters. Counting them would let a
    // fully vocalized text outvote a longer unvocalized one.
    expect(detectDirection('كَتَبَ book')).toBe(LTR);
  });
});

describe('readTextDirection', () => {
  it('reads an override', () => {
    expect(readTextDirection({ plaid: { textDirection: 'rtl' } })).toBe(RTL);
    expect(readTextDirection({ plaid: { textDirection: 'ltr' } })).toBe(LTR);
  });

  it('reads anything else as automatic', () => {
    expect(readTextDirection(undefined)).toBe(AUTO);
    expect(readTextDirection({})).toBe(AUTO);
    expect(readTextDirection({ plaid: {} })).toBe(AUTO);
    expect(readTextDirection({ plaid: { textDirection: 'auto' } })).toBe(AUTO);
    expect(readTextDirection({ plaid: { textDirection: 'sideways' } })).toBe(AUTO);
  });
});

describe('resolveDirection', () => {
  it('lets an override beat the text', () => {
    expect(resolveDirection({ plaid: { textDirection: 'ltr' } }, ARABIC)).toBe(LTR);
    expect(resolveDirection({ plaid: { textDirection: 'rtl' } }, ENGLISH)).toBe(RTL);
  });

  it('falls back to the text when nothing is set', () => {
    expect(resolveDirection(null, ARABIC)).toBe(RTL);
    expect(resolveDirection({}, ENGLISH)).toBe(LTR);
  });

  it('never answers AUTO', () => {
    expect(resolveDirection({ plaid: { textDirection: 'auto' } }, '')).toBe(LTR);
  });
});

describe('textDirectionOps', () => {
  it('sets the one key', () => {
    expect(textDirectionOps(RTL)).toEqual([
      { op: 'set', path: ['plaid', 'textDirection'], value: 'rtl' },
    ]);
  });

  it('deletes the key rather than storing auto', () => {
    // A document set back to automatic has to read the same as one nobody has
    // ever touched, or the two would resolve the same way for different
    // reasons and only one of them would follow the text if it changed.
    expect(textDirectionOps(AUTO)).toEqual([{ op: 'delete', path: ['plaid', 'textDirection'] }]);
  });
});

describe('withTextDirection', () => {
  // The optimistic copy has to be what the server makes of the ops.
  const cases = [
    [{}, RTL],
    [{ plaid: { textDirection: 'rtl' } }, AUTO],
    [{ plaid: { role: 'baseline' }, Speaker: 'Amina' }, RTL],
    [{ plaid: { role: 'baseline', textDirection: 'ltr' } }, AUTO],
    [{ Speaker: 'Amina' }, AUTO],
    [undefined, LTR],
  ];
  it.each(cases)('matches the server on %j set to %s', (before, value) => {
    expect(withTextDirection(before, value)).toEqual(
      applyMetadataOps(before, textDirectionOps(value)),
    );
  });

  it('keeps whatever else is in the namespace', () => {
    const before = { plaid: { role: 'baseline' }, Speaker: 'Amina' };
    expect(withTextDirection(before, RTL)).toEqual({
      plaid: { role: 'baseline', textDirection: 'rtl' },
      Speaker: 'Amina',
    });
  });

  it('reads as automatic once cleared', () => {
    expect(readTextDirection(withTextDirection({ plaid: { textDirection: 'rtl' } }, AUTO))).toBe(
      AUTO,
    );
  });
});
