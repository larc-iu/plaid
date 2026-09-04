import { describe, it, expect } from 'vitest';
import {
  composeInsert,
  composePending,
  composeString,
  lookupCode,
  isComposeCode,
  COMPOSE_PREFIX,
} from './compose.js';
import { COMPOSE_TABLE } from './composeTable.js';

// Type a whole string one character at a time through composeInsert, the way
// the DOM binder does, and return what the field ends up holding.
const type = (s) => {
  let value = '';
  let caret = 0;
  let escapedAt = -1;
  for (const ch of s) {
    const r = composeInsert(value, caret, ch, { escapedAt });
    if (r) {
      value = value.slice(0, r.start) + r.text + value.slice(r.end);
      caret = r.start + r.text.length;
      escapedAt = r.escapedAt ?? -1;
    } else {
      value = value.slice(0, caret) + ch + value.slice(caret);
      caret += 1;
    }
  }
  return value;
};

describe('the table', () => {
  it('is prefix-free: every code is exactly two characters', () => {
    const bad = Object.keys(COMPOSE_TABLE).filter((c) => [...c].length !== 2);
    expect(bad).toEqual([]);
  });

  it('carries the codes this app leans on', () => {
    expect(lookupCode('sw')).toBe('ə');
    expect(lookupCode('ng')).toBe('ŋ');
    expect(lookupCode('?g')).toBe('ʔ');
    expect(lookupCode(':f')).toBe('ː');
    expect(isComposeCode('zz')).toBe(false);
  });

  it('spells the empty set both Praat\u2019s way and the easy way', () => {
    expect(lookupCode('O|')).toBe('∅');
    expect(lookupCode('0/')).toBe('∅');
  });

  it('never maps `u` + a hex digit, so the code-point escape is unambiguous', () => {
    const clashes = Object.keys(COMPOSE_TABLE).filter(
      (c) => c[0] === 'u' && /[0-9a-fA-F]/.test(c[1]),
    );
    expect(clashes).toEqual([]);
  });
});

describe('typing codes', () => {
  it('composes a two-character code', () => {
    expect(type('\\sw')).toBe('ə');
    expect(type('\\ng')).toBe('ŋ');
  });

  it('composes inside a word without disturbing it', () => {
    expect(type('k\\swt')).toBe('kət');
  });

  it('leaves an unknown code exactly as typed', () => {
    expect(type('\\zz')).toBe('\\zz');
  });

  it('never fires without the prefix: metalanguage words survive', () => {
    // The whole reason for a prefix. A bare digraph table would eat these.
    for (const w of ['blue', 'true', 'queue', 'duel', 'sweet', 'ngoma']) {
      expect(type(w)).toBe(w);
    }
  });

  it('takes a code point by number', () => {
    expect(type('\\u2205')).toBe('∅');
    expect(type('\\u0250')).toBe('ɐ');
  });

  it('prefers the table over the code-point escape', () => {
    // `\u-` is ʉ. It must not be read as the start of a number.
    expect(type('\\u-')).toBe('ʉ');
    expect(type('\\u"')).toBe('ü');
  });

  it('abandons an incomplete code point escape as typed', () => {
    expect(type('\\u22')).toBe('\\u22');
    expect(type('\\u22x')).toBe('\\u22x');
  });
});

describe('the literal backslash', () => {
  it('collapses a doubled prefix to one character', () => {
    expect(type('\\\\')).toBe(COMPOSE_PREFIX);
  });

  it('does not re-arm: an escaped backslash never opens a code', () => {
    // The bug a stateless scan would have. After `\\` the field holds one
    // backslash, and typing `sw` next must NOT compose against it.
    expect(type('\\\\sw')).toBe('\\sw');
    expect(type('\\\\0/')).toBe('\\0/');
  });

  it('still composes after an escaped one is left behind', () => {
    expect(type('\\\\x\\sw')).toBe('\\xə');
  });
});

describe('composePending', () => {
  const at = (v, opts) => composePending(v, v.length, opts);

  it('is true while a code is open', () => {
    expect(at('\\')).toBe(true);
    expect(at('\\i')).toBe(true);
    expect(at('dog\\l')).toBe(true);
  });

  it('is true mid code-point escape', () => {
    expect(at('\\u2')).toBe(true);
    expect(at('\\u220')).toBe(true);
  });

  it('is false with nothing open', () => {
    expect(at('')).toBe(false);
    expect(at('dog')).toBe(false);
    expect(at('ə')).toBe(false);
  });

  it('is false for an escaped backslash', () => {
    expect(composePending('\\', 1, { escapedAt: 0 })).toBe(false);
    expect(composePending('\\i', 2, { escapedAt: 0 })).toBe(false);
  });

  // This is what stands the morpheme split down: both of these end in a
  // character the grid would otherwise treat as a boundary.
  it('covers the codes that collide with the split gesture', () => {
    expect(lookupCode('i-')).toBe('ɨ');
    expect(lookupCode('u-')).toBe('ʉ');
    expect(lookupCode('l-')).toBe('ɬ');
    expect(lookupCode('-5')).toBe('˥');
    expect(at('\\i')).toBe(true); // the `-` that follows must not split
    expect(at('\\')).toBe(true); // nor the one that starts `\-5`
  });
});

describe('composeString', () => {
  it('applies codes across a whole string', () => {
    expect(composeString('\\swk\\ng')).toBe('əkŋ');
  });

  it('handles the escape and the code point form', () => {
    expect(composeString('\\\\sw')).toBe('\\sw');
    expect(composeString('\\u2205')).toBe('∅');
  });

  it('leaves a backslash that opens nothing', () => {
    expect(composeString('\\zz')).toBe('\\zz');
    expect(composeString('a\\')).toBe('a\\');
  });

  it('is identity on text with no prefix', () => {
    expect(composeString('ngoma')).toBe('ngoma');
    expect(composeString('')).toBe('');
  });
});
