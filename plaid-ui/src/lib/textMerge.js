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
  const whole = (s, e) =>
    (s === 0 || breaks([units[s - 1]]) > 0) && (e === units.length || breaks([units[e - 1]]) > 0);
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
