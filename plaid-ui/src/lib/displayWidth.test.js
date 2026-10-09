import { describe, it, expect } from 'vitest';
import { displayWidth, padToWidth } from './displayWidth.js';

// H12-IO-5: a plain-text interlinear export lines its columns up by the
// columns each cell takes, not by its code points.

describe('displayWidth', () => {
  it('counts printable ASCII one column a character', () => {
    expect(displayWidth('han-geul')).toBe(8);
    expect(displayWidth('')).toBe(0);
    expect(displayWidth(null)).toBe(0);
  });

  it('counts a letter with its marks as one column', () => {
    expect(displayWidth('cafe\u0301')).toBe(4);
    expect(displayWidth('caf\u00e9')).toBe(4);
    // Thai: ก with sara u and mai ek, a hyphen, ง
    expect(displayWidth('\u0e01\u0e38\u0e48-\u0e07')).toBe(3);
    // Arabic with shadda and fatha
    expect(displayWidth('\u0643\u0651\u064e\u062a\u064e\u0628\u064e')).toBe(3);
    // Hebrew shin with its dot and qamats
    expect(displayWidth('\u05e9\u05c1\u05b8\u05dc')).toBe(2);
    // ẹ́ written as e, dot below, acute, then the acute as its own morpheme
    expect(displayWidth('e\u0323-\u0301-ba')).toBe(5);
  });

  it('counts wide characters two columns, Hangul in jamo too', () => {
    expect(displayWidth('\ud55c-\uae00')).toBe(5);
    expect(displayWidth('\u1112\u1161\u11ab')).toBe(2);
    expect(displayWidth('\u4e0d\u89c1')).toBe(4);
    expect(displayWidth('\uac00-\u11a8')).toBe(5);
  });

  it('counts nothing for what is drawn as nothing', () => {
    expect(displayWidth('a\u200bb')).toBe(2);
    expect(displayWidth('\u0301')).toBe(0);
  });

  it('counts an astral letter once', () => {
    expect(displayWidth('\ud835\udc00')).toBe(1);
    expect(displayWidth('\ud800\udf30\ud800\udf31')).toBe(2);
  });
});

describe('padToWidth', () => {
  it('pads to the columns asked for, never shortening', () => {
    expect(padToWidth('\ud55c', 4)).toBe('\ud55c  ');
    expect(padToWidth('cafe\u0301', 6)).toBe('cafe\u0301  ');
    expect(padToWidth('long', 2)).toBe('long');
  });
});
