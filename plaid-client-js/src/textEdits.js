/**
 * Text edit operations: composing a stream of ops into the net change.
 *
 * An op is one of the shapes `PATCH /texts/:id` takes:
 *
 *   { type: 'insert',  index, value: string }
 *   { type: 'delete',  index, value: count }
 *   { type: 'replace', index, length, value: string }
 *
 * Every index and count is in Unicode CODE POINTS (see ./codepoint.js), and
 * the ops are in running coordinates: each op's `index` is in the body as the
 * ops before it left it.
 *
 * A GAP is `{ start, end, value }` in the OLD body's coordinates: old
 * [start, end) gives way to `value`. `composeTextEdits` turns any op stream
 * into gaps that depend only on the net change, never on how the keystrokes
 * came, which is also how the server reads an edit. The Python client's
 * `plaid_client.text_edits` is the twin of this module.
 */

const codePoints = (s) => [...s];

// The last body split into code points, kept: an edit log composes the same
// long body once for each of its kept states, and splitting it each time made
// a save on a long text block the page (H31-TEXT-1). Frozen, as every caller
// shares it.
let lastBody = null;
let lastPoints = Object.freeze([]);

/** The code points of `body`, as a frozen array shared with other callers. */
export function bodyCodePoints(body) {
  if (body !== lastBody) {
    lastPoints = Object.freeze(codePoints(body));
    lastBody = body;
  }
  return lastPoints;
}

function opName(op) {
  return JSON.stringify(op);
}

/**
 * The op's type after checking its shape and bounds against a body of `len`
 * code points, as the server checks it. Throws an Error otherwise.
 */
function checkOp(op, len) {
  const type = op && op.type;
  const { index, value, length } = op || {};
  const int = Number.isInteger;
  const wellFormed =
    (type === 'insert' && int(index) && typeof value === 'string') ||
    (type === 'delete' && int(index) && int(value)) ||
    (type === 'replace' && int(index) && int(length) && typeof value === 'string');
  if (!wellFormed) {
    throw new Error(
      `Malformed text edit operation: ${opName(op)}. Expected {type: "insert", index: int, ` +
        `value: string}, {type: "delete", index: int, value: int} or {type: "replace", ` +
        `index: int, length: int, value: string}`,
    );
  }
  const inBounds =
    type === 'insert'
      ? index >= 0 && index <= len
      : type === 'delete'
        ? index >= 0 && value >= 0 && index + value <= len
        : index >= 0 && length >= 0 && index + length <= len;
  if (!inBounds) {
    throw new Error(
      `Text edit operation out of bounds: ${opName(op)} (text length is ${len} code points)`,
    );
  }
  return type;
}

// How many code points an op removes and what it types.
function opParts(type, op) {
  if (type === 'insert') return [0, op.value];
  if (type === 'delete') return [op.value, ''];
  return [op.length, op.value];
}

const segLength = (seg) => (seg.old ? seg.end - seg.start : seg.chars.length);

// The segment list of the new text, cut so that a segment boundary falls at
// code point `at`. Returns the index of the first segment at or after `at`.
function cutAt(segs, at) {
  let pos = 0;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const n = segLength(seg);
    if (at === pos) return i;
    if (at < pos + n) {
      const k = at - pos;
      const left = seg.old
        ? { old: true, start: seg.start, end: seg.start + k }
        : { old: false, chars: seg.chars.slice(0, k) };
      const right = seg.old
        ? { old: true, start: seg.start + k, end: seg.end }
        : { old: false, chars: seg.chars.slice(k) };
      segs.splice(i, 1, left, right);
      return i + 1;
    }
    pos += n;
  }
  return segs.length;
}

/**
 * The net change of `ops` applied in turn to `body`, as gaps in the old
 * body's code points: sorted, and never touching (at least one old code point
 * is kept between two gaps). Old text deleted and typed back is typed text,
 * and a gap whose value is the old text it removes is dropped. Throws on a
 * malformed or out-of-bounds op.
 */
export function composeTextEdits(body, ops) {
  const old = bodyCodePoints(body);
  let segs = old.length ? [{ old: true, start: 0, end: old.length }] : [];
  let len = old.length;
  for (const op of ops) {
    const type = checkOp(op, len);
    const [del, typed] = opParts(type, op);
    const chars = codePoints(typed);
    const from = cutAt(segs, op.index);
    const to = cutAt(segs, op.index + del);
    const inserted = chars.length ? [{ old: false, chars }] : [];
    segs.splice(from, to - from, ...inserted);
    len += chars.length - del;
    segs = mergeTyped(segs);
  }

  const gaps = [];
  let kept = 0; // the old position the last kept run ended at
  let typed = [];
  const close = (next) => {
    if (next > kept || typed.length) {
      const value = typed.join('');
      if (value !== old.slice(kept, next).join('')) gaps.push({ start: kept, end: next, value });
    }
    typed = [];
  };
  for (const seg of segs) {
    if (seg.old) {
      close(seg.start);
      kept = seg.end;
    } else {
      typed.push(...seg.chars);
    }
  }
  close(old.length);
  return gaps;
}

// Neighbouring typed segments as one, and neighbouring old ranges as one.
function mergeTyped(segs) {
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && !last.old && !seg.old) {
      out[out.length - 1] = { old: false, chars: last.chars.concat(seg.chars) };
    } else if (last && last.old && seg.old && last.end === seg.start) {
      out[out.length - 1] = { old: true, start: last.start, end: seg.end };
    } else if (segLength(seg) > 0) {
      out.push(seg);
    }
  }
  return out;
}

/**
 * Gaps (old-body coordinates, sorted, not overlapping) as running ops: an
 * insert where a gap removes nothing, a delete where it types nothing, and a
 * replace otherwise.
 */
export function gapsToOps(gaps) {
  const ops = [];
  let shift = 0;
  for (const { start, end, value } of gaps) {
    const index = start + shift;
    const typed = codePoints(value).length;
    if (start === end) {
      if (typed) ops.push({ type: 'insert', index, value });
    } else if (!typed) {
      ops.push({ type: 'delete', index, value: end - start });
    } else {
      ops.push({ type: 'replace', index, length: end - start, value });
    }
    shift += typed - (end - start);
  }
  return ops;
}

/**
 * `body` with `ops` applied in turn (running coordinates, code points).
 * Throws on a malformed or out-of-bounds op.
 */
export function applyTextOps(body, ops) {
  let chars = codePoints(body);
  for (const op of ops) {
    const type = checkOp(op, chars.length);
    const [del, typed] = opParts(type, op);
    chars = chars
      .slice(0, op.index)
      .concat(codePoints(typed), chars.slice(op.index + del));
  }
  return chars.join('');
}
