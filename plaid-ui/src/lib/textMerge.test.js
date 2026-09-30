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
  // A gap less the start and end it shares with the text it replaces.
  const trim = (text, gaps) =>
    gaps
      .map((g) => {
        const was = [...text].slice(g.start, g.end);
        const now = [...g.value];
        let pre = 0;
        while (pre < was.length && pre < now.length && was[pre] === now[pre]) pre += 1;
        let suf = 0;
        while (
          suf < was.length - pre &&
          suf < now.length - pre &&
          was[was.length - 1 - suf] === now[now.length - 1 - suf]
        ) {
          suf += 1;
        }
        return G(g.start + pre, g.end - suf, now.slice(pre, now.length - suf).join(''));
      })
      .filter((g) => g.start < g.end || g.value);

  it('moves a change by the other side’s changes before it, in code points', () => {
    const base = '𐌰𐌱 the dog ran';
    // ours: `dog` to `cat`
    const gaps = [G(7, 10, 'cat')];
    // theirs: `the` to `a 𐌲𐌳𐌴`, two code points longer, before ours
    const result = rebaseEdits(base, gaps, '𐌰𐌱 a 𐌲𐌳𐌴 dog ran');
    expect(result).toEqual({ gaps: [G(9, 12, 'cat')] });
    expect(onto('𐌰𐌱 a 𐌲𐌳𐌴 dog ran', result)).toBe('𐌰𐌱 a 𐌲𐌳𐌴 cat ran');
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

  it('keeps our typed word where it was typed, where a diff would put it after theirs', () => {
    // `na` typed between the two spaces before `na`, and the other side made that `na` `rana`
    const base = 'dog  na .';
    const result = rebaseEdits(base, [G(4, 4, 'na')], 'dog  rana .');
    expect(onto('dog  rana .', result)).toBe('dog na rana .');
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

  it('merges every pair mergeText merges, to the same text or with our change kept as typed', () => {
    const r = rng(4099);
    let both = 0;
    let onlyRebase = 0;
    for (let t = 0; t < 6000; t += 1) {
      const base = randomText(r, 2 + Math.floor(r() * 8));
      const gaps = composeTextEdits(base, randomOps(r, base));
      const mine = applyTextOps(base, gapsToOps(gaps));
      const stored = applyTextOps(base, randomOps(r, base));
      const merged = mergeText(base, mine, stored);
      const result = rebaseEdits(base, gaps, stored);
      const where = JSON.stringify({ base, gaps, stored });
      if (result.conflict) {
        expect(merged.conflict, where).toBe(true);
        continue;
      }
      const text = onto(stored, result);
      if (merged.conflict) {
        onlyRebase += 1;
      } else {
        both += 1;
        if (text === merged.text) continue;
      }
      // Our change as typed, moved: our gaps, each taking the text it took
      // from the base, less any the other side made too. A deletion may have
      // taken the separator on its other side instead, which leaves the same
      // text.
      const own = trim(base, gaps);
      const taken = (text, g) => [...text].slice(g.start, g.end).join('');
      const same = (o, g) =>
        o.value === g.value &&
        (o.value === ''
          ? o.end - o.start === g.end - g.start
          : taken(base, o) === taken(stored, g));
      let i = 0;
      for (const g of result.gaps) {
        while (i < own.length && !same(own[i], g)) {
          i += 1;
        }
        expect(i < own.length, where).toBe(true);
        i += 1;
      }
    }
    expect(both).toBeGreaterThan(1500);
    expect(onlyRebase).toBeGreaterThan(20);
  });
});
