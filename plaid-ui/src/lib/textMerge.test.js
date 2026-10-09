import { describe, expect, it } from 'vitest';
import { mergeText, rebaseEdits, textUnits, unitHunks } from './textMerge.js';
import {
  applyTextOps,
  composeTextEdits,
  gapsToOps,
} from '../../../plaid-client-js/src/textEdits.js';

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
// Mulberry32, whose period is 2^32: a linear congruential one repeated its
// cases about every 1,000 draws.
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

  it('keeps a deleted word and an edit to the word after it', () => {
    expect(mergeText('the big dog ran', 'the dog ran', 'the big cat ran')).toEqual({
      text: 'the cat ran',
    });
    expect(mergeText('a b c d', 'a c d', 'a b d')).toEqual({ text: 'a d' });
  });

  it('keeps a deleted line and an edit to the line after or before it', () => {
    expect(mergeText('one\ntwo\nthree', 'one\nthree', 'one\ntwo\nTHREE')).toEqual({
      text: 'one\nTHREE',
    });
    expect(mergeText('one\ntwo\nthree', 'one\ntwo', 'one\nTWO\nthree')).toEqual({
      text: 'one\nTWO',
    });
  });

  it('is a conflict when a word is put in where the other side changed the next word', () => {
    expect(mergeText('the dog ran', 'the big dog ran', 'the cat ran')).toEqual({ conflict: true });
    expect(mergeText('a b', 'a b b', 'a X')).toEqual({ conflict: true });
  });

  it('is a conflict when a deleted line reads like the line the other side edited', () => {
    // One word-level reading of the deletion keeps the start of the edited
    // line and the end of the next, which would put "of" into the "away" line.
    const base = [
      'the dog ran home',
      'and the cat sat',
      'and the cat sat',
      'the dog ran home',
      'the dog ran home',
      'the dog ran away',
    ].join('\n');
    const mine = base.replace('the dog ran home\nthe dog ran home\n', 'the dog ran home\n');
    const theirs = base.replace(
      'the dog ran home\nthe dog ran home\nthe dog ran away',
      'the dog ran home\nthe of ran home\nthe dog ran away',
    );
    expect(mergeText(base, mine, theirs)).toEqual({ conflict: true });
    expect(mergeText(base, theirs, mine)).toEqual({ conflict: true });
  });

  it('is a conflict when one of two last lines that read the same is deleted and the other edited', () => {
    // The deleted line may be the last, which has no line break of its own
    // and goes with the one before it.
    const base = 'the dog ran\nthe dog ran';
    const theirs = 'the dog ran\nthe cat ran';
    expect(mergeText(base, 'the dog ran', theirs)).toEqual({ conflict: true });
    expect(mergeText(base, theirs, 'the dog ran')).toEqual({ conflict: true });
    expect(mergeText(`a b\n${base}`, 'a b\nthe dog ran', `a b\n${theirs}`)).toEqual({
      conflict: true,
    });
  });

  it('is a conflict when a side made of repeated words has more than one shortest diff', () => {
    // The shortest diff of `theirs` scatters over lines 2 to 5, and `mine`'s
    // insertion in line 4 fits between its pieces.
    const base = 'la la la ta ta ta\nna ta ta na\nla\nna na la\nla la na na la la';
    const mine = 'la la la ta ta ta\nna ta ta na\nla\nna la na la\nla la na na la la';
    const theirs = 'la la la ta ta ta\nna ta ta la na\nla\nna na la';
    expect(mergeText(base, mine, theirs)).toEqual({ conflict: true });
  });

  it('keeps two deletions that share the separator between them', () => {
    // each deletes one of two lines, or one of two words
    expect(mergeText('L0 x\nL1 y\nL2 z', 'L0 x\nL2 z', 'L1 y\nL2 z')).toEqual({ text: 'L2 z' });
    expect(mergeText('L0 x\nL1 y\nL2 z', 'L1 y\nL2 z', 'L0 x\nL2 z')).toEqual({ text: 'L2 z' });
    expect(mergeText('dog, cat bird', 'cat bird', 'dog, bird')).toEqual({ text: 'bird' });
    expect(mergeText('dog, cat bird', 'dog, bird', 'cat bird')).toEqual({ text: 'bird' });
  });

  it('keeps a deleted line and a word put at the end of the line before', () => {
    expect(mergeText('L0 x\nL1 y\nL2 z', 'L0 x Q\nL1 y\nL2 z', 'L0 x\nL2 z')).toEqual({
      text: 'L0 x Q\nL2 z',
    });
    expect(mergeText('L0 x\nL1 y\nL2 z', 'L0 x\nL2 z', 'L0 x Q\nL1 y\nL2 z')).toEqual({
      text: 'L0 x Q\nL2 z',
    });
  });

  it('is a conflict when a word is put at the end of a line the other side deleted', () => {
    // A deletes line 3 and adds W to line 2, B deletes line 2.
    const base = 'L1 a\nL2 b\nL3 c\nL4';
    expect(mergeText(base, 'L1 a\nL2 b W\nL4', 'L1 a\nL3 c\nL4')).toEqual({ conflict: true });
    expect(mergeText(base, 'L1 a\nL3 c\nL4', 'L1 a\nL2 b W\nL4')).toEqual({ conflict: true });
  });

  it('is a conflict when one side joins two lines that read alike and the other edited one', () => {
    // The shortest diff of `theirs` takes `ran away\nthe dog ran` out and puts
    // `of` in: one line of the parts of two, where the line `mine` changed
    // may be either.
    const base = [
      'the dog ran away',
      'the dog ran away',
      'the dog ran away',
      'the dog ran home',
      'the dog ran away',
    ].join('\n');
    const mine = base.replace('away\nthe dog ran away\nthe dog', 'away\nthe dog away\ndog');
    const theirs = [
      'the dog ran away',
      'the dog ran away',
      'the dog of home',
      'the dog ran away',
    ].join('\n');
    expect(mergeText(base, mine, theirs)).toEqual({ conflict: true });
    expect(mergeText(base, theirs, mine)).toEqual({ conflict: true });
  });

  it('keeps a deleted line and an edit to a line that reads differently', () => {
    const base = 'the dog ran home\nthe cat sat\nthe dog ran away';
    expect(
      mergeText(
        base,
        'the dog ran home\nthe dog ran away',
        'the dog ran home\nthe cat sat\nthe dog ran far away',
      ),
    ).toEqual({ text: 'the dog ran home\nthe dog ran far away' });
  });

  // Lines of words drawn from a few repeated lines (a refrain), and two users'
  // edits to distinct words or whole lines. The merge never builds a line out
  // of the pieces of two: every line it gives is a line of the model result,
  // or a line one of the two sides wrote, or it refuses.
  it('never joins two refrain lines into one', () => {
    const r = rng(53);
    const POOL = [
      ['the', 'dog', 'ran', 'home'],
      ['and', 'the', 'cat', 'sat'],
      ['the', 'dog', 'ran', 'away'],
    ];
    const FRESH = ['of', 'will', 'did', 'them'];
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const ser = (lines) => lines.map((l) => l.join(' ')).join('\n');
    const edit = (lines, lineAt, kind) => {
      const out = lines.map((l) => [...l]);
      if (kind === 'dline') out.splice(lineAt, 1);
      else out[lineAt][Math.floor(r() * 4)] = pick(FRESH);
      return out;
    };
    let merged = 0;
    for (let t = 0; t < 600; t += 1) {
      const lines = Array.from({ length: 3 + Math.floor(r() * 5) }, () => pick(POOL));
      const a = Math.floor(r() * lines.length);
      let b = Math.floor(r() * lines.length);
      if (b === a) b = (a + 1) % lines.length;
      const mineLines = edit(lines, a, r() < 0.5 ? 'dline' : 'word');
      const theirLines = edit(lines, b, 'word');
      const mine = ser(mineLines);
      const theirs = ser(theirLines);
      const result = mergeText(ser(lines), mine, theirs);
      if (result.conflict) continue;
      merged += 1;
      const allowed = new Set([...mineLines, ...theirLines].map((l) => l.join(' ')));
      const both = lines.map((l, i) => (i === b ? theirLines[b] : l));
      const model =
        mineLines.length < lines.length
          ? both.filter((_, i) => i !== a)
          : both.map((l, i) => (i === a ? mineLines[a] : l));
      model.forEach((l) => allowed.add(l.join(' ')));
      for (const line of result.text.split('\n')) expect(allowed).toContain(line);
    }
    expect(merged).toBeGreaterThan(200);
  });

  // Words with ids, lines of them, and two users' edits to distinct words:
  // replace, delete, or put a new word before or after. The merge is what
  // both did, or a refusal, and never another text.
  it('merges edits to distinct words into what both users did, or refuses', () => {
    const r = rng(41);
    const MARK = String.fromCodePoint(0x301);
    const stems = [(i) => `w${i}`, (i) => `ka${i}e${MARK}`, (i) => `كتاب${i}`, (i) => `𐌰${i}`];
    let n = 0;
    const fresh = () => stems[Math.floor(r() * stems.length)]((n += 1));
    const ser = (lines) => lines.map((l) => l.map((w) => w.t).join(' ')).join('\n');
    const apply = (lines, ops) =>
      lines.map((line) =>
        line.flatMap((w) => {
          const op = ops.get(w.id);
          if (!op) return [w];
          if (op.kind === 'delete') return [];
          if (op.kind === 'replace') return [{ t: op.t }];
          return op.kind === 'before' ? [{ t: op.t }, w] : [w, { t: op.t }];
        }),
      );
    let merged = 0;
    for (let t = 0; t < 400; t += 1) {
      const lines = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, l) =>
        Array.from({ length: 1 + Math.floor(r() * 5) }, (__, w) => ({
          id: `${l}.${w}`,
          t: fresh(),
        })),
      );
      const ids = lines.flat().map((w) => w.id);
      const kinds = ['replace', 'delete', 'before', 'after'];
      const mineOps = new Map();
      const theirOps = new Map();
      for (const id of ids) {
        const x = r();
        const op = { kind: kinds[Math.floor(r() * 4)], t: fresh() };
        if (x < 0.2) mineOps.set(id, op);
        else if (x < 0.4) theirOps.set(id, op);
      }
      // An insertion names a gap: two in one gap are the same place.
      const gap = (id, op) => {
        const [l, w] = id.split('.').map(Number);
        return op.kind === 'before' ? `${l}:${w}` : op.kind === 'after' ? `${l}:${w + 1}` : null;
      };
      const mineGaps = new Set([...mineOps].map(([id, op]) => gap(id, op)).filter(Boolean));
      if ([...theirOps].some(([id, op]) => mineGaps.has(gap(id, op)))) continue;
      const b = ser(lines);
      const mine = ser(apply(lines, mineOps));
      const theirs = ser(apply(lines, theirOps));
      const both = ser(apply(lines, new Map([...mineOps, ...theirOps])));
      const result = mergeText(b, mine, theirs);
      if (!result.conflict) {
        expect(result.text).toBe(both);
        merged += 1;
      }
    }
    expect(merged).toBeGreaterThan(250);
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

describe('rebaseEdits', () => {
  const G = (start, end, value) => ({ start, end, value });
  const onto = (stored, result) => applyTextOps(stored, gapsToOps(result.gaps));

  it('moves a change by the other side’s changes before it, in code points', () => {
    const base = '𐌰𐌱 the big dog ran';
    // ours: `dog` to `cat`
    const gaps = [G(11, 14, 'cat')];
    // theirs: `the` to `a 𐌲𐌳𐌴`, two code points longer, before ours
    const stored = '𐌰𐌱 a 𐌲𐌳𐌴 big dog ran';
    const result = rebaseEdits(base, gaps, stored);
    expect(result).toEqual({ gaps: [G(13, 16, 'cat')] });
    expect(onto(stored, result)).toBe('𐌰𐌱 a 𐌲𐌳𐌴 big cat ran');
    // With no word between, the `𐌲𐌳𐌴 ` they put in may stand right before
    // `dog`, which meets ours: a conflict.
    expect(rebaseEdits('𐌰𐌱 the dog ran', [G(7, 10, 'cat')], '𐌰𐌱 a 𐌲𐌳𐌴 dog ran')).toEqual({
      conflict: true,
    });
  });

  it('keeps a change inside a word exactly where it was typed', () => {
    // `do|g`: an `o` typed after the first `o`, and the other side changed a later word
    const result = rebaseEdits('the dog ran', [G(6, 6, 'o')], 'the dog walked');
    expect(result).toEqual({ gaps: [G(6, 6, 'o')] });
    expect(onto('the dog walked', result)).toBe('the doog walked');
  });

  it('is a conflict when both changed the same word', () => {
    expect(rebaseEdits('the dog ran', [G(4, 7, 'cat')], 'the cow ran')).toEqual({
      conflict: true,
    });
    // a letter typed at the end of a word the other side changed
    expect(rebaseEdits('the dog ran', [G(7, 7, 's')], 'the cow ran')).toEqual({ conflict: true });
  });

  it('answers no gaps when the other side made the same change', () => {
    expect(rebaseEdits('the dog ran', [G(4, 7, 'cat')], 'the cat ran')).toEqual({ gaps: [] });
  });

  it('answers the gaps unchanged when the stored text is the base', () => {
    expect(rebaseEdits('ab cd', [G(0, 2, 'x')], 'ab cd')).toEqual({ gaps: [G(0, 2, 'x')] });
  });

  // Words that each stand once, so a change to one cannot be read anywhere else.
  const UNIQUE = ['kai', 'na', 'dog', '𐌰𐌱', 'ǃxóõ', 'ran', '猫', 'the', 'é', 'tree', 'sun'];

  it('never merges a gap that reaches into a word the other side changed', () => {
    const r = rng(20260930);
    let checked = 0;
    for (let t = 0; t < 3000; t += 1) {
      const words = [...UNIQUE].sort(() => r() - 0.5).slice(0, 3 + Math.floor(r() * 6));
      let base = '';
      const spans = [];
      for (const w of words) {
        const start = [...base].length;
        base += w;
        spans.push([start, start + [...w].length]);
        base += SEPS[Math.floor(r() * SEPS.length)];
      }
      const k = Math.floor(r() * words.length);
      const [ws, we] = spans[k];
      // theirs: the word changed to another, or deleted
      const stored = applyTextOps(base, [
        r() < 0.5
          ? { type: 'replace', index: ws, length: we - ws, value: 'zz' }
          : { type: 'delete', index: ws, value: we - ws },
      ]);
      // ours: a gap reaching into that word
      const start = ws + Math.floor(r() * (we - ws));
      const end = Math.min(start + Math.floor(r() * 4), [...base].length);
      const value = r() < 0.5 ? '' : ['q', 'x y', 'kai'][Math.floor(r() * 3)];
      if (start === end && start === ws) continue;
      const gaps = composeTextEdits(base, [
        { type: 'replace', index: start, length: end - start, value },
      ]);
      // the same change on both sides is no conflict
      if (gaps.length === 0 || applyTextOps(base, gapsToOps(gaps)) === stored) continue;
      checked += 1;
      expect(rebaseEdits(base, gaps, stored), JSON.stringify({ base, gaps, stored })).toEqual({
        conflict: true,
      });
    }
    expect(checked).toBeGreaterThan(2000);
  });

  // Random keystroke streams over random texts, both sides.
  const randomOps = (r, body) => {
    const ops = [];
    let len = [...body].length;
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i += 1) {
      const index = Math.floor(r() * (len + 1));
      const kind = r();
      if (kind < 0.4) {
        const w = WORDS[Math.floor(r() * WORDS.length)];
        const value = r() < 0.5 ? w : SEPS[Math.floor(r() * SEPS.length)] + w;
        ops.push({ type: 'insert', index, value });
        len += [...value].length;
      } else if (kind < 0.8) {
        const value = Math.min(len - index, Math.floor(r() * 5));
        ops.push({ type: 'delete', index, value });
        len -= value;
      } else {
        const length = Math.min(len - index, Math.floor(r() * 4));
        const value = WORDS[Math.floor(r() * WORDS.length)];
        ops.push({ type: 'replace', index, length, value });
        len += [...value].length - length;
      }
    }
    return ops;
  };

  it('never merges a random pair to a text other than mergeText’s, nor a pair it refuses', () => {
    const r = rng(4099);
    let both = 0;
    for (let t = 0; t < 6000; t += 1) {
      const base = randomText(r, 2 + Math.floor(r() * 8));
      const gaps = composeTextEdits(base, randomOps(r, base));
      const mine = applyTextOps(base, gapsToOps(gaps));
      const stored = applyTextOps(base, randomOps(r, base));
      const merged = mergeText(base, mine, stored);
      const result = rebaseEdits(base, gaps, stored);
      const where = JSON.stringify({ base, gaps, stored });
      if (result.conflict) continue;
      expect(merged.conflict, where).toBeUndefined();
      expect(onto(stored, result), where).toBe(merged.text);
      both += 1;
    }
    expect(both).toBeGreaterThan(1000);
  });

  it('refuses a change the other side made too beside an identical word', () => {
    // A deleted one `the` of `the the`, B deleted the other and changed `ran`
    const base = 'I saw the the dog. It ran.';
    const stored = 'I saw the dog. It run.';
    for (const gaps of [[G(6, 10, '')], [G(10, 14, '')], [G(5, 9, '')]]) {
      expect(rebaseEdits(base, gaps, stored), JSON.stringify(gaps)).toEqual({ conflict: true });
    }
    // the same with nothing else changed: which `the` went is not known
    expect(rebaseEdits(base, [G(6, 10, '')], 'I saw the dog. It ran.')).toEqual({
      conflict: true,
    });
    // a word typed beside its twin, and the other side typed it too
    expect(rebaseEdits('a dog ran', [G(2, 2, 'dog ')], 'a dog dog ran zz')).toEqual({
      conflict: true,
    });
  });

  it('never puts in again a word change the other side made too, beside twins', () => {
    // ours: a word deleted, or a copy of it put in before it; theirs: the
    // same text with ` zz` at the end
    const r = rng(7);
    const V = ['the', 'a', 'la', 'dog', 'ran'];
    let merged = 0;
    for (let t = 0; t < 5000; t += 1) {
      const n = 4 + Math.floor(r() * 8);
      const w = Array.from({ length: n }, () => V[Math.floor(r() * V.length)]);
      const base = w.join(' ');
      const k = Math.floor(r() * (n - 1));
      const at = w.slice(0, k).reduce((p, x) => p + x.length + 1, 0);
      const gaps = r() < 0.5 ? [G(at, at + w[k].length + 1, '')] : [G(at, at, `${w[k]} `)];
      const stored = `${applyTextOps(base, gapsToOps(gaps))} zz`;
      const result = rebaseEdits(base, gaps, stored);
      if (result.conflict) continue;
      merged += 1;
      expect(onto(stored, result), JSON.stringify({ base, gaps })).toBe(stored);
    }
    expect(merged).toBeGreaterThan(200);
  });

  it('refuses a change beside an identical word the other side deleted or changed', () => {
    // ours deletes one `b` of three, theirs another
    expect(rebaseEdits('x b b b y', [G(4, 6, '')], 'x b b y')).toEqual({ conflict: true });
    expect(rebaseEdits('x cat cat cat y', [G(0, 0, 'Z '), G(9, 13, '')], 'x cat cat y')).toEqual({
      conflict: true,
    });
    expect(rebaseEdits('one\ntwo\ntwo\nthree', [G(8, 12, '')], 'one\ntwo\nthree')).toEqual({
      conflict: true,
    });
    // our `na` typed between two spaces before `na`, which the other side made `rana`
    expect(rebaseEdits('dog  na .', [G(4, 4, 'na')], 'dog  rana .')).toEqual({ conflict: true });
    // ours deletes the second `the`, theirs changes the first
    expect(rebaseEdits('the the dog', [G(3, 7, '')], 'a the dog')).toEqual({ conflict: true });
  });

  it('follows a change along a long run of one word', () => {
    // ours deletes the first `la ` of a hundred, which may as well be any
    // other, such as the fiftieth, which the other side changed
    const base = `x y ${'la '.repeat(100)}z`;
    const gaps = [G(4, 7, '')];
    const mid = 4 + 49 * 3;
    const changed = `${base.slice(0, mid)}lo${base.slice(mid + 2)}`;
    expect(rebaseEdits(base, gaps, changed)).toEqual({ conflict: true });
    // a change past the run's other end, with a word between, merges
    const result = rebaseEdits(base, gaps, `w${base.slice(1)}`);
    expect(onto(`w${base.slice(1)}`, result)).toBe(`w y ${'la '.repeat(99)}z`);
  });

  it('refuses changes that meet', () => {
    // a word deleted with its space, and the next word changed
    expect(rebaseEdits('a big dog ran', [G(2, 6, '')], 'a big cat ran')).toEqual({
      conflict: true,
    });
    // two neighbours deleted
    expect(rebaseEdits('a big dog ran', [G(2, 6, '')], 'a big ran')).toEqual({ conflict: true });
  });

  // A careful three-way merge over words: each side's change is every
  // shortest set of word changes (delete, put in, replace) that makes its
  // text. Two different changes to one word, or two different words put in
  // at one place, clash. Where every pair of readings merges to one text,
  // that text is the merge, and otherwise the merge is not known.
  const wordReadings = (a, b) => {
    const n = a.length;
    const m = b.length;
    const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n; i >= 0; i -= 1) {
      for (let j = m; j >= 0; j -= 1) {
        if (i === n || j === m) d[i][j] = n - i + (m - j);
        else if (a[i] === b[j]) d[i][j] = d[i + 1][j + 1];
        else d[i][j] = 1 + Math.min(d[i + 1][j], d[i][j + 1], d[i + 1][j + 1]);
      }
    }
    const out = [];
    // a reading: per base word 'keep', 'del' or a new word, and per place the words put in
    const walk = (i, j, words, puts) => {
      if (i === n && j === m) {
        out.push({ words: [...words], puts: puts.map((p) => [...p]) });
        return;
      }
      const cost = d[i][j];
      if (i < n && j < m && a[i] === b[j] && d[i + 1][j + 1] === cost) {
        words.push('keep');
        walk(i + 1, j + 1, words, puts);
        words.pop();
      }
      if (i < n && j < m && a[i] !== b[j] && d[i + 1][j + 1] === cost - 1) {
        words.push(b[j]);
        walk(i + 1, j + 1, words, puts);
        words.pop();
      }
      if (i < n && d[i + 1][j] === cost - 1) {
        words.push('del');
        walk(i + 1, j, words, puts);
        words.pop();
      }
      if (j < m && d[i][j + 1] === cost - 1) {
        puts[i].push(b[j]);
        walk(i, j + 1, words, puts);
        puts[i].pop();
      }
    };
    walk(
      0,
      0,
      [],
      Array.from({ length: n + 1 }, () => []),
    );
    return { cost: d[0][0], readings: out };
  };
  const applyReading = (a, x) => {
    const out = [];
    for (let i = 0; i <= a.length; i += 1) {
      out.push(...x.puts[i]);
      if (i === a.length) break;
      if (x.words[i] === 'keep') out.push(a[i]);
      else if (x.words[i] !== 'del') out.push(x.words[i]);
    }
    return out;
  };
  // Both readings applied, or null when they clash.
  const mergeReadings = (a, x, y) => {
    const words = [];
    const puts = [];
    for (let i = 0; i <= a.length; i += 1) {
      const px = x.puts[i].join(' ');
      const py = y.puts[i].join(' ');
      if (px && py && px !== py) return null;
      puts.push(px ? x.puts[i] : y.puts[i]);
      if (i === a.length) break;
      const wx = x.words[i];
      const wy = y.words[i];
      if (wx !== 'keep' && wy !== 'keep' && wx !== wy) return null;
      words.push(wx === 'keep' ? wy : wx);
    }
    return applyReading(a, { words, puts }).join(' ');
  };
  const carefulMerge = (a, mine, theirs) => {
    const ours = wordReadings(a, mine).readings;
    const other = wordReadings(a, theirs).readings;
    let text = null;
    for (const x of ours) {
      for (const y of other) {
        const merged = mergeReadings(a, x, y);
        if (merged === null || (text !== null && merged !== text)) return { unknown: true };
        text = merged;
      }
    }
    return { text };
  };

  it('merges only what a careful merge over words merges, to the same text', () => {
    const r = rng(20261001);
    const POOL = ['the', 'a', 'la', 'dog', 'ran'];
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const stats = { cases: 0, merged: 0, unknown: 0, refusedKnown: 0 };
    for (let t = 0; t < 20000; t += 1) {
      const vocab = POOL.slice(0, 3 + Math.floor(r() * 3));
      const n = 3 + Math.floor(r() * 6);
      const words = Array.from({ length: n }, () => pick(vocab));
      const base = words.join(' ');
      const starts = [];
      let p = 0;
      for (const w of words) {
        starts.push(p);
        p += [...w].length + 1;
      }
      // One or two changes of distinct words and places, as a reading.
      const change = (count) => {
        const x = { words: words.map(() => 'keep'), puts: Array.from({ length: n + 1 }, () => []) };
        for (let k = 0; k < count; k += 1) {
          const kind = r();
          const i = Math.floor(r() * n);
          if (kind < 0.35) x.words[i] = 'del';
          else if (kind < 0.7) x.words[i] = pick(vocab.filter((w) => w !== words[i]));
          else x.puts[Math.floor(r() * (n + 1))] = [pick(vocab)];
        }
        return x;
      };
      const ours = change(1 + Math.floor(r() * 2));
      const mineWords = applyReading(words, ours);
      if (mineWords.length === 0) continue;
      // our change must be a shortest one, so it is one of its readings
      const count = (x) =>
        x.words.filter((w) => w !== 'keep').length + x.puts.reduce((k, q) => k + q.length, 0);
      if (count(ours) !== wordReadings(words, mineWords).cost) continue;
      // Our gaps as typed: a deleted word goes with the space after it or
      // before it, and a word put in goes before the next word or after the
      // one before.
      const ops = [];
      for (let i = n; i >= 0; i -= 1) {
        if (i < n && ours.words[i] !== 'keep') {
          const [s, e] = [starts[i], starts[i] + [...words[i]].length];
          if (ours.words[i] !== 'del') {
            ops.push({ type: 'replace', index: s, length: e - s, value: ours.words[i] });
          } else if (i === n - 1 || (i > 0 && r() < 0.5)) {
            ops.push({ type: 'delete', index: s - 1, value: e - s + 1 });
          } else {
            ops.push({ type: 'delete', index: s, value: e - s + 1 });
          }
        }
        if (ours.puts[i].length) {
          const w = ours.puts[i][0];
          if (i < n && (i === 0 || r() < 0.5)) {
            ops.push({ type: 'insert', index: starts[i], value: `${w} ` });
          } else {
            ops.push({
              type: 'insert',
              index: starts[i - 1] + [...words[i - 1]].length,
              value: ` ${w}`,
            });
          }
        }
      }
      // Ops from the end, so each index is in the base as the ops before
      // left it. Two neighbours deleted may both take the space between them,
      // which makes another text: such a case is left out.
      let gaps;
      try {
        gaps = composeTextEdits(base, ops);
      } catch {
        continue;
      }
      const mine = applyTextOps(base, gapsToOps(gaps));
      if (mine !== mineWords.join(' ')) continue;
      // Theirs: unrelated, our change again with or without another, or our
      // change made to another word that reads the same.
      let theirs;
      const kind = r();
      if (kind < 0.4) theirs = change(1 + Math.floor(r() * 2));
      else if (kind < 0.7) {
        theirs = { words: [...ours.words], puts: ours.puts.map((q) => [...q]) };
        if (r() < 0.6) {
          const extra = change(1);
          extra.words.forEach((w, i) => {
            if (w !== 'keep') theirs.words[i] = w;
          });
          extra.puts.forEach((q, i) => {
            if (q.length) theirs.puts[i] = q;
          });
        }
      } else {
        theirs = { words: words.map(() => 'keep'), puts: Array.from({ length: n + 1 }, () => []) };
        ours.words.forEach((w, i) => {
          if (w === 'keep') return;
          const twins = words.map((x, j) => j).filter((j) => words[j] === words[i]);
          theirs.words[pick(twins)] = w;
        });
        ours.puts.forEach((q, i) => {
          if (q.length) theirs.puts[Math.max(0, Math.min(n, i + pick([-1, 0, 1])))] = q;
        });
      }
      const storedWords = applyReading(words, theirs);
      const stored = storedWords.join(' ');
      if (stored === base || storedWords.length === 0) continue;
      stats.cases += 1;
      const where = JSON.stringify({ base, gaps, stored });
      const careful = carefulMerge(words, mineWords, storedWords);
      const result = rebaseEdits(base, gaps, stored);
      const byMergeText = mergeText(base, mine, stored);
      if (careful.unknown) {
        stats.unknown += 1;
        expect(result, where).toEqual({ conflict: true });
        continue;
      }
      if (result.conflict) {
        stats.refusedKnown += 1;
        continue;
      }
      stats.merged += 1;
      expect(onto(stored, result), where).toBe(careful.text);
      expect(byMergeText, where).toEqual({ text: careful.text });
    }
    expect(stats.cases).toBeGreaterThan(12000);
    expect(stats.unknown).toBeGreaterThan(1000);
    expect(stats.merged).toBeGreaterThan(3000);
  });
});

describe('rebaseEdits onto a text the server composed', () => {
  const G = (start, end, value) => ({ start, end, value });
  const onto = (stored, result) => applyTextOps(stored, gapsToOps(result.gaps));
  // what was sent, an acute typed after the a of `ba`, came back composed
  const base = 'pata bá ko';
  const stored = 'pata bá ko';

  it('moves what was typed since onto the composed text', () => {
    // `y` typed after `bá`, and `z` at the end
    const result = rebaseEdits(base, [G(8, 8, 'y'), G(11, 11, 'z')], stored);
    expect(result).toEqual({ gaps: [G(7, 7, 'y'), G(10, 10, 'z')] });
    expect(onto(stored, result)).toBe('pata báy koz');
  });

  it('moves it beside someone else’s change too', () => {
    const theirs = 'pata bá ko mi';
    const result = rebaseEdits(base, [G(0, 0, 'x')], theirs);
    expect(onto(theirs, result)).toBe('xpata bá ko mi');
  });

  it('does not place an edge between a letter and the mark composed with it', () => {
    // a dot below typed between the a and its acute: no place in `bá`
    const result = rebaseEdits(base, [G(7, 7, '̣')], 'pata bá ko!');
    expect(result).toEqual({ conflict: true });
  });

  it('leaves a text the server did not compose as it was', () => {
    const theirs = 'pata bá ko mi';
    const result = rebaseEdits(base, [G(0, 0, 'x')], theirs);
    expect(onto(theirs, result)).toBe('xpata bá ko mi');
  });
});

// The server keeps a character decomposed where a token edge falls inside it
// (a tone mark that is a word of its own right after "ka", Luke 2026-10-09)
// and composes the rest. Text typed decomposed elsewhere comes back composed
// beside it, which is no change by anyone else.
describe('rebaseEdits onto a text that keeps a character decomposed', () => {
  const G = (start, end, value) => ({ start, end, value });
  const onto = (stored, result) => applyTextOps(stored, gapsToOps(result.gaps));
  // sent: "me" and an acute typed after it, beside the kept "ka" + acute
  const base = 'ka\u0301 me\u0301';
  const stored = 'ka\u0301 m\u00e9';

  it('moves what was typed since onto the text as stored', () => {
    const result = rebaseEdits(base, [G(7, 7, 'x')], stored);
    expect(result).toEqual({ gaps: [G(6, 6, 'x')] });
    expect(onto(stored, result)).toBe('ka\u0301 m\u00e9x');
  });

  it('moves it beside someone else’s change too', () => {
    const theirs = 'ka\u0301 m\u00e9 ko';
    const result = rebaseEdits(base, [G(0, 0, 'x')], theirs);
    expect(onto(theirs, result)).toBe('xka\u0301 m\u00e9 ko');
  });

  it('places an edge between the kept letter and its mark', () => {
    const result = rebaseEdits(base, [G(2, 2, 'y')], stored);
    expect(onto(stored, result)).toBe('kay\u0301 m\u00e9');
  });
});
