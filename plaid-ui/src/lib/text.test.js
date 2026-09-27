import { describe, it, expect } from 'vitest';
import { clipText } from './text.js';

describe('clipText', () => {
  it('leaves text within the limit as it is', () => {
    expect(clipText('abc', 3)).toBe('abc');
    expect(clipText('', 3)).toBe('');
    expect(clipText(null, 3)).toBe('');
  });

  it('counts code points, so an astral character is one', () => {
    expect(clipText('\u{1F600}\u{1F600}\u{1F600}', 2)).toBe('\u{1F600}\u{1F600}');
    expect(clipText('ab\u{10330}c', 3)).toBe('ab\u{10330}');
  });

  it('never cuts a letter from its combining mark or an emoji sequence', () => {
    expect(clipText('abe\u0301', 3)).toBe('ab');
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(clipText(`x${family}y`, 3)).toBe('x');
  });

  it('cuts by code point when one grapheme alone is past the limit', () => {
    expect(clipText('e\u0301\u0301\u0301', 2)).toBe('e\u0301');
  });
});
