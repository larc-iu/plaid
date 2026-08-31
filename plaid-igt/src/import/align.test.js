import { describe, it, expect } from 'vitest';
import { makeCpIndexer, matchesAt, foldChar } from './align.js';

describe('makeCpIndexer', () => {
  it('is the identity for a string with no astral characters', () => {
    const at = makeCpIndexer('perros corren');
    expect([at(0), at(6), at(13)]).toEqual([0, 6, 13]);
  });

  it('counts a surrogate pair as one code point', () => {
    const s = 'a😀b'; // 4 UTF-16 units, 3 code points
    const at = makeCpIndexer(s);
    expect(s.length).toBe(4);
    expect([at(0), at(1), at(3), at(4)]).toEqual([0, 1, 2, 3]);
  });

  it('clamps out-of-range indexes rather than returning undefined', () => {
    for (const s of ['abc', 'a😀b']) {
      const at = makeCpIndexer(s);
      expect(at(-5)).toBe(0);
      expect(at(999)).toBe([...s].length);
    }
  });

  it('agrees with the naive conversion at every code-point boundary', () => {
    const s = 'a😀b́c𝔘d ẞ😀';
    const at = makeCpIndexer(s);
    let u = 0;
    for (const ch of s) {
      expect(at(u)).toBe([...s.slice(0, u)].length);
      u += ch.length;
    }
    expect(at(s.length)).toBe([...s].length);
  });

  it('maps an index inside a surrogate pair to the code point containing it', () => {
    // Offsets never split a code point in practice (matching advances whole
    // code points), so this only has to be defined, not equal to the naive
    // conversion, which would count a lone surrogate as a character.
    const at = makeCpIndexer('a😀b');
    expect(at(2)).toBe(1);
  });
});

describe('matchesAt', () => {
  it('matches case-foldedly and returns the index just past the match', () => {
    expect(matchesAt('За что', 0, 'за')).toBe(2);
    expect(matchesAt('За что', 0, 'xx')).toBe(false);
    expect(matchesAt('abc', 2, 'cd')).toBe(false);
  });

  it('folds the Turkish dotted capital I onto i', () => {
    expect(foldChar('İ')).toBe('i');
  });
});
