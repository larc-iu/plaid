import { describe, expect, it } from 'vitest';
import { mergeText, textUnits, unitHunks } from './textMerge.js';

const apply = (units, hunks) => {
  let out = [];
  let pos = 0;
  for (const h of hunks) {
    out = out.concat(units.slice(pos, h.start), h.insert);
    pos = h.end;
  }
  return out.concat(units.slice(pos));
};

// A small seeded generator, so a failure names the case that made it.
const rng = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const WORDS = ['the', 'dog', 'ran', 'kai', 'na', '𐌰𐌱', 'é', 'é', '.', ',', 'ǃxóõ', '猫'];
const SEPS = [' ', ' ', '\n', '  '];

const randomText = (r, n) => {
  let s = '';
  for (let i = 0; i < n; i += 1) {
    s += WORDS[Math.floor(r() * WORDS.length)];
    s += SEPS[Math.floor(r() * SEPS.length)];
  }
  return s;
};

describe('textUnits', () => {
  it('splits into words, whitespace runs and single other characters, losing nothing', () => {
    expect(textUnits('The dog, ran.\n\nOK')).toEqual([
      'The',
      ' ',
      'dog',
      ',',
      ' ',
      'ran',
      '.',
      '\n\n',
      'OK',
    ]);
    const r = rng(7);
    for (let t = 0; t < 50; t += 1) {
      const s = randomText(r, 30);
      expect(textUnits(s).join('')).toBe(s);
    }
  });

  it('keeps a combining mark with its letter', () => {
    expect(textUnits('café x')).toEqual(['café', ' ', 'x']);
  });
});

describe('unitHunks', () => {
  it('turns one unit list into the other, for random pairs', () => {
    const r = rng(11);
    for (let t = 0; t < 300; t += 1) {
      const a = textUnits(randomText(r, Math.floor(r() * 40)));
      const b = textUnits(randomText(r, Math.floor(r() * 40)));
      const hunks = unitHunks(a, b);
      expect(apply(a, hunks)).toEqual(b);
      for (let i = 1; i < hunks.length; i += 1) {
        expect(hunks[i].start).toBeGreaterThan(hunks[i - 1].end);
      }
    }
  });

  it('finds a small change in a long text as a small hunk', () => {
    const a = textUnits('one two three four five');
    const b = textUnits('one two THREE four five');
    expect(unitHunks(a, b)).toEqual([{ start: 4, end: 5, insert: ['THREE'] }]);
  });
});

describe('mergeText', () => {
  const base = 'The big fish swam.\nThey slept.';

  it('keeps both edits when they change different words', () => {
    expect(
      mergeText(base, 'The big fish swam.\nThen they slept.', 'The fish swam.\nThey slept.'),
    ).toEqual({ text: 'The fish swam.\nThen they slept.' });
    expect(
      mergeText(
        base,
        'The big fish swam far.\nThey slept.',
        'The big fish swam.\nThey slept well.',
      ),
    ).toEqual({ text: 'The big fish swam far.\nThey slept well.' });
  });

  it('keeps an appended line and the other edit', () => {
    expect(
      mergeText(base, `${base} Then they woke.`, 'The big red fish swam.\nThey slept.'),
    ).toEqual({ text: 'The big red fish swam.\nThey slept. Then they woke.' });
  });

  it('is a conflict when both change the same word differently', () => {
    expect(
      mergeText(base, 'The large fish swam.\nThey slept.', 'The huge fish swam.\nThey slept.'),
    ).toEqual({ conflict: true });
  });

  it('is a conflict when the two changes touch', () => {
    expect(mergeText('a b c', 'a bb c', 'a b, c')).toEqual({ conflict: true });
  });

  it('takes the same change made on both sides once', () => {
    expect(
      mergeText(base, 'The big fish swims.\nThey slept.', 'The big fish swims.\nThey slept.'),
    ).toEqual({ text: 'The big fish swims.\nThey slept.' });
    expect(mergeText('a b c d', 'a B c D', 'a B c d')).toEqual({ text: 'a B c D' });
  });

  it('answers the other side when one side made no change', () => {
    expect(mergeText(base, base, 'x')).toEqual({ text: 'x' });
    expect(mergeText(base, 'y', base)).toEqual({ text: 'y' });
  });

  it('merges edits in separate places of random texts, astral and marked letters included', () => {
    const r = rng(23);
    for (let t = 0; t < 200; t += 1) {
      const left = randomText(r, 10);
      const middle = randomText(r, 3);
      const right = randomText(r, 10);
      const leftEdit = randomText(r, 5);
      const rightEdit = randomText(r, 5);
      // A fixed word between keeps the two edits from touching.
      const b = `${left}MID ${middle}MID ${right}`;
      const mine = `${leftEdit}MID ${middle}MID ${right}`;
      const theirs = `${left}MID ${middle}MID ${rightEdit}`;
      expect(mergeText(b, mine, theirs)).toEqual({
        text: `${leftEdit}MID ${middle}MID ${rightEdit}`,
      });
    }
  });

  it('gives the same text whichever side is called mine', () => {
    const r = rng(31);
    let merged = 0;
    for (let t = 0; t < 400; t += 1) {
      const b = randomText(r, 12);
      const edit = (s) => {
        const u = textUnits(s);
        const at = Math.floor(r() * u.length);
        u.splice(at, Math.floor(r() * 3), ...textUnits(randomText(r, 1)));
        return u.join('');
      };
      const mine = edit(b);
      const theirs = edit(b);
      const one = mergeText(b, mine, theirs);
      expect(mergeText(b, theirs, mine)).toEqual(one);
      if (!one.conflict) merged += 1;
    }
    expect(merged).toBeGreaterThan(100);
  });
});
