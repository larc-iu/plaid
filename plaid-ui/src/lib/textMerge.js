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
 */
export function mergeText(base, mine, theirs) {
  if (mine === theirs || theirs === base) return { text: mine };
  if (mine === base) return { text: theirs };
  const units = textUnits(base);
  const mineUnits = textUnits(mine);
  const theirUnits = textUnits(theirs);
  let text = null;
  for (const read of READINGS) {
    const merged = applyBoth(units, read(units, mineUnits), read(units, theirUnits));
    if (merged === null || (text !== null && merged !== text)) return { conflict: true };
    text = merged;
  }
  return { text };
}
