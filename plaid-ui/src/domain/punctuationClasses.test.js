import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unpackRanges } from '../lib/unicodeRanges.js';
import { repoRoot } from '../test/apps.js';
import { isTokenIgnored } from './igtWordBreaks.js';
import {
  LETTER_SYMBOLS,
  PICTOGRAPHIC,
  PUNCT_OR_SYMBOL,
  isPictograph,
  isPunctOrSymbol,
} from './punctuationClasses.js';

const PUNCT = { type: 'unicodePunctuation', whitelist: [] };

// The ranges `rs` holds less the code points `minus` holds.
const without = (rs, minus) => {
  const out = [];
  for (const [a, b] of rs) {
    for (let cp = a; cp <= b; cp++) {
      if (minus.some(([x, y]) => x <= cp && cp <= y)) continue;
      const last = out[out.length - 1];
      if (last && last[1] === cp - 1) last[1] = cp;
      else out.push([cp, cp]);
    }
  }
  return out;
};

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
      expect(PUNCT_OR_SYMBOL).toEqual(without(runtimeRanges(/[\p{P}\p{S}]/u), LETTER_SYMBOLS));
      expect(PICTOGRAPHIC).toEqual(runtimeRanges(/\p{Extended_Pictographic}/u));
    },
  );

  // plaid-core's text rules read the same run's table (FX-I-FOLLOW 2).
  it('are the table plaid-core reads', () => {
    const file = path.join(repoRoot(), 'plaid-core/resources/punctuation_classes.txt');
    const rows = Object.fromEntries(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'))
        .map((l) => {
          const [k, ...rest] = l.trim().split(/ +/);
          return [k, unpackRanges(rest.join(' '))];
        }),
    );
    expect(rows.punct).toEqual(PUNCT_OR_SYMBOL);
    expect(rows.picto).toEqual(PICTOGRAPHIC);
    expect(rows.letters).toEqual(LETTER_SYMBOLS);
  });

  // Owner ruling 2026-11-17 (H16-7): the modifier tone letters and the emoji
  // skin-tone modifiers are Unicode symbols (Sk) that a word is written with,
  // so they are letters to the ignore rule, and no other symbol is.
  it('read the tone letters and the skin-tone modifiers as letters', () => {
    expect(LETTER_SYMBOLS).toEqual([
      [0x2e5, 0x2eb],
      [0x2f9, 0x2fc],
      [0xa700, 0xa716],
      [0xa720, 0xa721],
      [0x1f3fb, 0x1f3ff],
    ]);
    for (const [a, b] of LETTER_SYMBOLS) {
      for (let cp = a; cp <= b; cp++) {
        expect(isPunctOrSymbol(String.fromCodePoint(cp))).toBe(false);
      }
    }
    for (const t of ['˥˩', '˧', '˥', '꜒꜖', '꜠', '˹', '🏽', '🏻🏿']) {
      expect(isTokenIgnored(t, PUNCT)).toBe(false);
    }
    // Every other Sk stays a symbol: spacing accents, arrowheads, the
    // unaspirated mark, the raised colon, the shelf, the modifier colon.
    for (const c of ['^', '`', '˄', '˭', '˸', '˽', '꞉']) {
      expect(isPunctOrSymbol(c)).toBe(true);
      expect(isTokenIgnored(c, PUNCT)).toBe(true);
    }
  });
});
