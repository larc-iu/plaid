// Three-way merge of a whole text, for the editors that save a document's
// body whole (igt's Baseline tab, ud's Text Editor). A draft typed on a copy
// that someone else has since saved over is put onto the stored text: the
// passages the draft changed are changed there, and the rest keeps what the
// other save made. Two changes to the same passage, or to passages that touch,
// are a conflict, and nothing is merged. So is a change whose place is not
// known, as when one of two lines that read the same is deleted and the other
// side edited one of them.
//
// The unit is a word, a run of whitespace, or one other character, so two
// edits to different words of one line merge, and two edits to one word do
// not. Offsets never matter here: the result is a whole string.

// Letters with their combining marks, and digits, make a word.
const UNIT = /\s+|[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu;

export const textUnits = (text) => String(text ?? '').match(UNIT) || [];

// Past this many differing units, the middle between the common start and end
// is taken as one change. That is always safe: a coarser change can only
// conflict where a finer one would have merged.
const MAX_EDITS = 2000;

// The changes that turn `a` into `b`, as `{ start, end, insert }`: the units
// a[start..end) give way to `insert`. In order, and never touching one another.
// Where a change could stand in more than one place (a word deleted from a run
// of the same word), it stands as early as it can.
export function unitHunks(a, b) {
  return hunksOf(a, b).map((h) => ({
    start: h.start,
    end: h.end,
    insert: b.slice(h.bStart, h.bEnd),
  }));
}

// The same changes, each as late as it can stand.
function unitHunksFromEnd(a, b) {
  const n = a.length;
  return unitHunks([...a].reverse(), [...b].reverse())
    .map((h) => ({ start: n - h.end, end: n - h.start, insert: [...h.insert].reverse() }))
    .reverse();
}

// The same changes found line by line first, and word by word only inside the
// lines that changed, so a deleted line is a whole line. The word-level
// readings can take it as the end of one line and the start of the next when
// the two read alike.
function lineHunks(a, b) {
  const la = lineSpans(a);
  const lb = lineSpans(b);
  const keysA = la.map(([s, e]) => a.slice(s, e).join(''));
  const keysB = lb.map(([s, e]) => b.slice(s, e).join(''));
  const hunks = [];
  for (const block of hunksOf(keysA, keysB)) {
    const from = block.start < la.length ? la[block.start][0] : a.length;
    const to = block.end > block.start ? la[block.end - 1][1] : from;
    const bFrom = block.bStart < lb.length ? lb[block.bStart][0] : b.length;
    const bTo = block.bEnd > block.bStart ? lb[block.bEnd - 1][1] : bFrom;
    for (const h of hunksOf(a.slice(from, to), b.slice(bFrom, bTo))) {
      hunks.push({
        start: from + h.start,
        end: from + h.end,
        insert: b.slice(bFrom + h.bStart, bFrom + h.bEnd),
      });
    }
  }
  return hunks;
}

// Each line as a unit range, the whitespace that ends it included.
function lineSpans(units) {
  const spans = [];
  let from = 0;
  units.forEach((u, i) => {
    if (u.includes('\n')) {
      spans.push([from, i + 1]);
      from = i + 1;
    }
  });
  if (from < units.length) spans.push([from, units.length]);
  return spans;
}

// The changes that turn list `a` into list `b`, as `{ start, end, bStart,
// bEnd }`: a[start..end) gives way to b[bStart..bEnd). In order, never
// touching one another.
function hunksOf(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf += 1;
  }
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length === 0 && bm.length === 0) return [];
  const script = editScript(am, bm);
  if (!script) {
    return [{ start: pre, end: pre + am.length, bStart: pre, bEnd: pre + bm.length }];
  }
  const hunks = [];
  let open = null;
  let x = pre;
  let y = pre;
  for (const op of script) {
    if (op === '=') {
      if (open) hunks.push(open);
      open = null;
      x += 1;
      y += 1;
      continue;
    }
    if (!open) open = { start: x, end: x, bStart: y, bEnd: y };
    if (op === '-') {
      x += 1;
      open.end = x;
    } else {
      y += 1;
      open.bEnd = y;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

// Myers' shortest edit script: '=' (keep an item), '-' (drop an item of a) and
// `{ unit }` (take an item of b), in order. Null past MAX_EDITS.
function editScript(a, b) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDITS);
  const size = 2 * limit + 3;
  const off = limit + 1;
  const v = new Int32Array(size);
  const trace = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
          ? v[off + k + 1]
          : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, k);
    }
  }
  return null;
}

function backtrack(trace, a, b, dEnd, kEnd) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  let k = kEnd;
  for (let d = dEnd; d > 0; d -= 1) {
    // trace[d] holds v as it stood before round d, over k in [-d-1, d+1].
    const row = trace[d];
    const at = (kk) => row[kk + d + 1];
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX + (down ? 0 : 1) && y > prevY + (down ? 1 : 0)) {
      ops.push('=');
      x -= 1;
      y -= 1;
    }
    if (down) {
      ops.push({ unit: b[prevY] });
      y -= 1;
    } else {
      ops.push('-');
      x -= 1;
    }
    k = prevK;
  }
  while (x > 0 && y > 0) {
    ops.push('=');
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

const sameHunk = (p, q) =>
  p.start === q.start &&
  p.end === q.end &&
  p.insert.length === q.insert.length &&
  p.insert.every((u, i) => u === q.insert[i]);

// Two changes touch when they overlap, or when one puts text in where the
// other begins or ends: which goes first is not known. Two changes that only
// meet (a word deleted with the space after it, and the next word changed)
// both apply.
const touch = (p, q) =>
  p.start === p.end || q.start === q.end
    ? p.start <= q.end && q.start <= p.end
    : p.start < q.end && q.start < p.end;

const isBlank = (u) => /^\s+$/u.test(u);
const breaks = (us) => us.reduce((n, u) => n + (u.match(/\n/g)?.length ?? 0), 0);
const pureDelete = (h) => h.insert.length === 0 && h.start < h.end;
const touchesAny = (h, list, skip) => list.some((q, i) => i !== skip && touch(h, q));

// The line each unit is on (a line ends with the whitespace that breaks it),
// with one more entry for the end of the text.
function lineOfUnits(units) {
  const at = new Int32Array(units.length + 1);
  let line = 0;
  units.forEach((u, i) => {
    at[i] = line;
    line += breaks([u]) > 0 ? 1 : 0;
  });
  at[units.length] = line;
  return at;
}

// Where a change that takes out a line break starts and ends in lines, and
// how much of them is left: [from, to) of the line it starts in and of the
// line its text runs on into.
function lineReach(units, lineOf, h) {
  const first = lineOf[h.start];
  const last = lineOf[h.end];
  let lineStart = h.start;
  while (lineStart > 0 && lineOf[lineStart - 1] === first) lineStart -= 1;
  let lineEnd = h.end;
  while (lineEnd < units.length && lineOf[lineEnd] === last) lineEnd += 1;
  return { first, last, lineStart, lineEnd };
}

// Whether a change of one side makes one line of two, each keeping words of
// its own or getting words typed by the same side: `L2 b\nL3 c` to `L2 b W`.
function joinsLines(units, lineOf, h, own) {
  if (breaks(units.slice(h.start, h.end)) <= breaks(h.insert)) return false;
  const { lineStart, lineEnd } = lineReach(units, lineOf, h);
  const words = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (!isBlank(units[i]) && !own.some((x) => x.start <= i && i < x.end)) return true;
    }
    return own.some(
      (x) => x !== h && x.start >= from && x.start <= to && x.insert.some((u) => !isBlank(u)),
    );
  };
  return words(lineStart, h.start) && words(h.end, lineEnd);
}

// A deletion that takes out a line break and lines' worth of text, moved to
// where it takes whole lines when the text it takes stays the same:
// `cat sat\nthe ` out of `the cat sat\nthe dog` is the line `the cat sat`.
function onWholeLines(units, lineOf, h, own) {
  if (!pureDelete(h) || breaks(units.slice(h.start, h.end)) === 0) return h;
  // The last line has no break of its own, and goes with the one before it.
  const whole = (s, e) =>
    ((s === 0 || breaks([units[s - 1]]) > 0) &&
      (e === units.length || breaks([units[e - 1]]) > 0)) ||
    (e === units.length && breaks([units[s]]) > 0 && breaks([units[e - 1]]) === 0);
  for (let k = 0; k <= 64; k += 1) {
    for (const by of k === 0 ? [0] : [-k, k]) {
      const s = h.start + by;
      const e = h.end + by;
      if (s < 0 || e > units.length || !whole(s, e)) continue;
      const moved = { start: s, end: e, insert: h.insert };
      if (own.some((x) => x !== h && touch(moved, x))) continue;
      let ok = true;
      for (let i = Math.min(s, h.start); ok && i < Math.max(s, h.start); i += 1) {
        ok = units[i] === units[i + (h.end - h.start)];
      }
      if (ok) return moved;
    }
  }
  return h;
}

// A deletion moved `by` units (1 or -1) over a separator: `the dog ran`
// less `dog ` is also less ` dog`. Null when the text it takes would differ.
function slideDelete(units, h, by) {
  const [from, to] = by > 0 ? [h.start, h.end] : [h.start - 1, h.end - 1];
  if (from < 0 || to >= units.length || units[from] !== units[to] || !isBlank(units[from]))
    return null;
  return { start: h.start + by, end: h.end + by, insert: h.insert };
}

// Where a deletion of one side touches a change of the other only on a
// separator the two can both do without, the deletion takes the other
// separator beside it: two users each deleting one of two lines, or one
// deleting a line and the other editing the line before. Each deletion moves
// one unit at most, only to where it touches nothing, and not in a line a
// change of either side joins to another, which may be the end of the line
// it deletes edited.
function spaceApart(units, lineOf, ours, other) {
  const sides = [[...ours], [...other]];
  // the lines a change of the side joins to another
  const joined = (side) => {
    const lines = new Set();
    for (const x of side) {
      if (!joinsLines(units, lineOf, x, side)) continue;
      for (let l = lineOf[x.start]; l <= lineOf[x.end]; l += 1) lines.add(l);
    }
    return lines;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [mine, theirs] of [
      [sides[0], sides[1]],
      [sides[1], sides[0]],
    ]) {
      mine.forEach((h, i) => {
        if (!pureDelete(h)) return;
        const touched = theirs.filter((q) => touch(h, q));
        if (touched.length === 0) return;
        if (
          joined(mine).has(lineOf[h.start]) ||
          touched.some((q) => joined(theirs).has(lineOf[q.start]))
        ) {
          return;
        }
        for (const by of [1, -1]) {
          const moved = slideDelete(units, h, by);
          if (moved && !touchesAny(moved, theirs) && !touchesAny(moved, mine, i)) {
            mine[i] = moved;
            return;
          }
        }
      });
    }
  }
  return sides;
}

// Whether a change of one side makes one line of the parts of two, both of
// which keep words (`ran away\nthe dog ran` taken out of the middle), where
// the start of the first also starts the last (or the end of the last also
// ends the first), while the other side changed a line such a change leaves
// in doubt. It may be the whole first line taken out and the last edited (or
// the other way round), and the other side's change then lands elsewhere.
function mixesEditedLines(units, lineOf, ours, other) {
  // a word of [from, to) that no change of this side takes
  const kept = (from, to) => {
    for (let i = from; i < to; i += 1) {
      if (!isBlank(units[i]) && !ours.some((h) => h.start <= i && i < h.end)) return true;
    }
    return false;
  };
  // the units of [from, to) that no change of this side takes
  const left = (from, to) =>
    units
      .slice(from, to)
      .filter((_, k) => !ours.some((h) => h.start <= from + k && from + k < h.end));
  const startsWith = (from, to, xs) =>
    xs.length <= to - from && xs.every((u, k) => units[from + k] === u);
  const endsWith = (from, to, xs) =>
    xs.length <= to - from && xs.every((u, k) => units[to - xs.length + k] === u);
  // [from, to) less the whitespace that ends it
  const bodyEnd = (from, to) => {
    while (to > from && isBlank(units[to - 1])) to -= 1;
    return to;
  };
  return ours.some((h) => {
    // a word taken out of a line of its own leaves the line (`\nka\n` to `\n\n`)
    if (breaks(units.slice(h.start, h.end)) <= breaks(h.insert)) return false;
    const { first, last, lineStart, lineEnd } = lineReach(units, lineOf, h);
    if (!kept(lineStart, h.start) || !kept(h.end, lineEnd)) return false;
    let firstEnd = h.start;
    while (firstEnd < units.length && lineOf[firstEnd] === first) firstEnd += 1;
    let lastStart = h.end;
    while (lastStart > 0 && lineOf[lastStart - 1] === last) lastStart -= 1;
    // what this side leaves of the first line before the change, and of the
    // last after it
    const head = left(lineStart, h.start);
    const tail = left(h.end, bodyEnd(h.end, lineEnd));
    // The last line starting as what is left of the first does, the change
    // may be the first line taken out whole and the last edited from where
    // that start ends: a change of the other side to the first is lost, and
    // one to that start of the last meets other words. The same the other
    // way round, the first ending as what is left of the last does.
    const doubt = [];
    if (startsWith(lastStart, lineEnd, head)) {
      doubt.push([lineStart, firstEnd], [lastStart, Math.max(h.end, lastStart + head.length)]);
    }
    const firstBodyEnd = bodyEnd(lineStart, firstEnd);
    if (endsWith(lineStart, firstBodyEnd, tail)) {
      doubt.push([Math.min(h.start, firstBodyEnd - tail.length), firstEnd], [lastStart, lineEnd]);
    }
    return other.some((q) => doubt.some(([from, to]) => touch(q, { start: from, end: to })));
  });
}

// Both lists of changes applied to `units`, or null when two of them touch
// and differ.
function applyBoth(units, ours, other) {
  const all = [];
  let i = 0;
  let j = 0;
  while (i < ours.length || j < other.length) {
    const p = ours[i];
    const q = other[j];
    if (p && q && touch(p, q)) {
      if (!sameHunk(p, q)) return null;
      all.push(p);
      i += 1;
      j += 1;
    } else if (!q || (p && p.start < q.start)) {
      all.push(p);
      i += 1;
    } else {
      all.push(q);
      j += 1;
    }
  }
  let out = '';
  let pos = 0;
  for (const h of all) {
    out += units.slice(pos, h.start).join('') + h.insert.join('');
    pos = h.end;
  }
  return out + units.slice(pos).join('');
}

const READINGS = [unitHunks, unitHunksFromEnd, lineHunks];

/**
 * Put the changes that turn `base` into `mine` onto `theirs`, which is `base`
 * as someone else changed it. Returns `{ text }`, or `{ conflict: true }` when
 * both changed the same passage (or two passages that touch) differently.
 *
 * Each side's changes are read three ways: as early as they can stand, as
 * late, and line by line. The merge takes both sides read the same way, for
 * each way. When one of these touches, or two give different texts, where a
 * change stands is not known, and that is a conflict too.
 *
 * In each reading, a deletion of lines' worth of text stands on whole lines
 * where it can, and a deletion touching the other side's change only on a
 * separator takes the separator beside it, so two users deleting adjacent
 * lines or words merge. A change joining the parts of two lines that start
 * or end alike, beside a change of the other side there, is a conflict: it
 * may be one of the lines taken out whole and the other edited.
 */
export function mergeText(base, mine, theirs) {
  if (mine === theirs || theirs === base) return { text: mine };
  if (mine === base) return { text: theirs };
  const units = textUnits(base);
  const mineUnits = textUnits(mine);
  const theirUnits = textUnits(theirs);
  const lineOf = lineOfUnits(units);
  let text = null;
  for (const read of READINGS) {
    const [ours, other] = spaceApart(
      units,
      lineOf,
      read(units, mineUnits).map((h, _, own) => onWholeLines(units, lineOf, h, own)),
      read(units, theirUnits).map((h, _, own) => onWholeLines(units, lineOf, h, own)),
    );
    if (
      mixesEditedLines(units, lineOf, ours, other) ||
      mixesEditedLines(units, lineOf, other, ours)
    ) {
      return { conflict: true };
    }
    const merged = applyBoth(units, ours, other);
    if (merged === null || (text !== null && merged !== text)) return { conflict: true };
    text = merged;
  }
  return { text };
}

// How many code points `s` holds.
const cpCount = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff || i + 1 >= s.length) n += 1;
  }
  return n;
};

// Where each unit starts, in code points, with the end of the text last.
const unitStarts = (units) => {
  const at = [0];
  units.forEach((u, i) => at.push(at[i] + cpCount(u)));
  return at;
};

// `text` with gaps (code points of `text`, sorted, apart) put in.
function applyGaps(text, gaps) {
  const chars = [...text];
  let out = '';
  let pos = 0;
  for (const g of gaps) {
    out += chars.slice(pos, g.start).join('') + g.value;
    pos = g.end;
  }
  return out + chars.slice(pos).join('');
}

// Our gaps as unit changes of `units`, each with the gaps it holds. A unit
// stays when no gap reaches into it and it is still one unit of the text the
// gaps make, which may take in a neighbour a gap only touches (`cat` less `t`
// and with `s` typed after it is the unit `cat` changed). Where the changes
// stand is known exactly: nothing is read from a diff.
function exactHunks(units, at, gaps, mine) {
  const n = units.length;
  // how far text no gap takes has moved in `mine`, at old code point `p`
  const shiftAt = (p) =>
    gaps.filter((g) => g.end <= p).reduce((k, g) => k + cpCount(g.value) - (g.end - g.start), 0);
  const mineUnits = textUnits(mine);
  const mineAt = unitStarts(mineUnits);
  const mineUnitAt = new Map();
  mineUnits.forEach((_, j) => mineUnitAt.set(mineAt[j], j));
  // for each unit of `units` that stays, the unit of `mine` it is
  const keptAs = new Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const s = at[i];
    const e = at[i + 1];
    const reached = gaps.some((g) =>
      g.start === g.end ? s < g.start && g.start < e : g.start < e && s < g.end,
    );
    if (reached) continue;
    const from = s + shiftAt(s);
    const j = mineUnitAt.get(from);
    if (j !== undefined && mineAt[j + 1] === from + (e - s)) keptAs[i] = j;
  }
  const hunks = [];
  let prevBase = 0; // units before this index are settled
  let prevMine = 0;
  const close = (base, mineIndex) => {
    if (base > prevBase || mineIndex > prevMine) {
      const lo = at[prevBase];
      const hi = at[base];
      hunks.push({
        start: prevBase,
        end: base,
        insert: mineUnits.slice(prevMine, mineIndex),
        gaps: gaps.filter((g) =>
          g.start === g.end ? lo <= g.start && g.start <= hi : lo <= g.start && g.end <= hi,
        ),
      });
    }
  };
  for (let i = 0; i < n; i += 1) {
    if (keptAs[i] < 0) continue;
    close(i, keptAs[i]);
    prevBase = i + 1;
    prevMine = keptAs[i] + 1;
  }
  close(n, mineUnits.length);
  // a gap at the edge of two changes goes with the first only
  const seen = new Set();
  for (const h of hunks) {
    h.gaps = h.gaps.filter((g) => !seen.has(g));
    h.gaps.forEach((g) => seen.add(g));
  }
  return seen.size === gaps.length ? hunks : null;
}

// Each gap less the start and end it shares with the text it replaces, and
// none that is left empty: the same change, standing where it touches less.
function trimGaps(text, gaps) {
  const old = [...text];
  const out = [];
  for (const g of gaps) {
    const was = old.slice(g.start, g.end);
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
    const start = g.start + pre;
    const end = g.end - suf;
    const value = now.slice(pre, now.length - suf).join('');
    if (start < end || value) out.push({ start, end, value });
  }
  return out;
}

// Past this many cells of a window's table, the whole text is taken as a
// place the changes could stand.
const MAX_WINDOW_CELLS = 250000;

// Where the changes that turn `a` into `b` could stand, over every shortest
// way to make `b` (a unit taken out or put in costs one): each unit that some
// such way takes out, or that two such ways keep as different units of `b`,
// as [i, i + 1], and each place some such way puts a unit in, as [i, i]. A
// change beside a unit that reads like its own may stand on either side of
// it, and a run of such units lets it stand anywhere along the run: `the `
// deleted from `the the dog` is either `the `. And `la la la` to
// `the la la the` is the first `la` made `the` and `the` put at the end, or
// `the` put in front and the last `la` made `the`: the middle `la` is kept
// either way, but as another unit of `b`, so a change to it has no one place.
function changeZone(a, b) {
  const hunks = hunksOf(a, b);
  // windows over runs of hunks, each with the places found in it
  const groups = [];
  let i = 0;
  while (i < hunks.length) {
    let first = i;
    let margin = 4;
    for (;;) {
      // The window over hunks[first..j], `margin` units past their ends. It
      // takes in an earlier window it would reach into, so the units between
      // its hunks and its edges are the same in `a` and `b`.
      while (
        groups.length &&
        hunks[groups[groups.length - 1].j].end > hunks[first].start - margin
      ) {
        first = groups.pop().first;
      }
      let j = first;
      while (j + 1 < hunks.length && hunks[j + 1].start - margin <= hunks[j].end + margin) j += 1;
      const lo = Math.max(0, hunks[first].start - margin);
      const hi = Math.min(a.length, hunks[j].end + margin);
      const bLo = hunks[first].bStart - (hunks[first].start - lo);
      const bHi = hunks[j].bEnd + (hi - hunks[j].end);
      if ((hi - lo + 1) * (bHi - bLo + 1) > MAX_WINDOW_CELLS) return [[0, a.length]];
      const zone = windowZone(a, b, lo, hi, bLo, bHi);
      // A way that reaches the window's edge may go on past it.
      const edge = (x) => (x[0] <= lo + 1 && lo > 0) || (x[1] >= hi - 1 && hi < a.length);
      if (!zone.some(edge)) {
        groups.push({ first, j, zone });
        i = j + 1;
        break;
      }
      margin *= 2;
    }
  }
  return groups.flatMap((g) => g.zone);
}

// `changeZone` of a[lo, hi) and b[bLo, bHi), in units of `a`.
function windowZone(a, b, lo, hi, bLo, bHi) {
  const n = hi - lo;
  const m = bHi - bLo;
  const w = m + 1;
  const same = (i, j) => a[lo + i] === b[bLo + j];
  // cost from the start to (i, j), and from (i, j) to the end
  const from = new Int32Array((n + 1) * w);
  const to = new Int32Array((n + 1) * w);
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= m; j += 1) {
      if (i === 0 && j === 0) continue;
      let c = Infinity;
      if (i > 0) c = from[(i - 1) * w + j] + 1;
      if (j > 0) c = Math.min(c, from[i * w + j - 1] + 1);
      if (i > 0 && j > 0 && same(i - 1, j - 1)) c = Math.min(c, from[(i - 1) * w + j - 1]);
      from[i * w + j] = c;
    }
  }
  for (let i = n; i >= 0; i -= 1) {
    for (let j = m; j >= 0; j -= 1) {
      if (i === n && j === m) continue;
      let c = Infinity;
      if (i < n) c = to[(i + 1) * w + j] + 1;
      if (j < m) c = Math.min(c, to[i * w + j + 1] + 1);
      if (i < n && j < m && same(i, j)) c = Math.min(c, to[(i + 1) * w + j + 1]);
      to[i * w + j] = c;
    }
  }
  const best = from[n * w + m];
  const zone = [];
  // for each unit, the unit of `b` it stays as in some shortest way, or -2
  // when it stays as more than one, or some way takes it out
  const keptAs = new Int32Array(n).fill(-1);
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= m; j += 1) {
      const f = from[i * w + j];
      if (i < n && f + 1 + to[(i + 1) * w + j] === best) keptAs[i] = -2;
      if (j < m && f + 1 + to[i * w + j + 1] === best) zone.push([lo + i, lo + i]);
      if (i < n && j < m && same(i, j) && f + to[(i + 1) * w + j + 1] === best) {
        keptAs[i] = keptAs[i] === -1 || keptAs[i] === j ? j : -2;
      }
    }
  }
  keptAs.forEach((j, i) => {
    if (j < 0) zone.push([lo + i, lo + i + 1]);
  });
  return zone;
}

// Ranges [lo, hi] put together where they overlap or meet, in order.
function joinRanges(ranges) {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// Whether two ranges [lo, hi] overlap or meet.
const near = (p, q) => p[0] <= q[1] && q[0] <= p[1];

/**
 * Move our gaps, made on `base`, onto `stored`, which is `base` as someone
 * else changed it. Gaps are `{ start, end, value }` in code points of the text
 * they are made on, sorted and apart (as plaid-client's `composeTextEdits`
 * gives them). Returns `{ gaps }` in code points of `stored`, or
 * `{ conflict: true }`.
 *
 * Only a move that cannot be read two ways is made, and a conflict leaves the
 * draft to the app. Each side's changes are taken at every place they could
 * stand: each shortest way to make its text (`changeZone`), the three ways
 * `mergeText` reads them, and ours also as typed, since a change typed beside
 * an identical word could as well have been typed at the other. A change of
 * ours at a place that overlaps or meets a place of the other side's is a
 * conflict. The one exception is the same change made on both sides where
 * neither side's changes could stand anywhere else near it: it is in `stored`
 * already, and ours is dropped. A change of ours that is kept moves by the
 * other side's changes before it, as typed.
 */
export function rebaseEdits(base, gaps, stored) {
  base = String(base ?? '');
  stored = String(stored ?? '');
  if (stored === base) return { gaps };
  const mine = applyGaps(base, gaps);
  if (mine === base) return { gaps: [] };
  const conflict = { conflict: true };
  const units = textUnits(base);
  const at = unitStarts(units);
  const lineOf = lineOfUnits(units);
  const exact = exactHunks(units, at, trimGaps(base, gaps), mine);
  if (!exact) return conflict;
  const mineUnits = textUnits(mine);
  const theirUnits = textUnits(stored);
  const ourReadings = [exact, ...READINGS.map((read) => read(units, mineUnits))];
  const theirReadings = READINGS.map((read) => read(units, theirUnits));
  for (const ours of ourReadings) {
    for (const other of theirReadings) {
      if (
        mixesEditedLines(units, lineOf, ours, other) ||
        mixesEditedLines(units, lineOf, other, ours)
      ) {
        return conflict;
      }
    }
  }
  const places = (readings, zone) =>
    joinRanges([...zone, ...readings.flat().map((h) => [h.start, h.end])]);
  const ourPlaces = places(ourReadings, changeZone(units, mineUnits));
  const theirPlaces = places(theirReadings, changeZone(units, theirUnits));
  // Our changes the other side made too, each standing in one place only.
  const made = new Set();
  for (const p of ourPlaces) {
    const met = theirPlaces.filter((q) => near(p, q));
    if (met.length === 0) continue;
    const h = exact.find((x) => x.start === p[0] && x.end === p[1]);
    const once =
      h &&
      met.length === 1 &&
      met[0][0] === p[0] &&
      met[0][1] === p[1] &&
      [...ourReadings, ...theirReadings].every((r) => r.some((x) => sameHunk(x, h)));
    if (!once) return conflict;
    made.add(h);
  }
  // Each reading of each side gives the same text.
  let text = null;
  for (const ours of ourReadings) {
    for (const other of theirReadings) {
      const merged = applyBoth(units, ours, other);
      if (merged === null || (text !== null && merged !== text)) return conflict;
      text = merged;
    }
  }
  const other = theirReadings[0];
  const moved = [];
  for (const h of exact) {
    if (made.has(h)) continue;
    const shift = other
      .filter((q) => q.end <= h.start)
      .reduce((k, q) => k + cpCount(q.insert.join('')) - (at[q.end] - at[q.start]), 0);
    for (const g of h.gaps) {
      moved.push({ start: g.start + shift, end: g.end + shift, value: g.value });
    }
  }
  return applyGaps(stored, moved) === text ? { gaps: moved } : conflict;
}
