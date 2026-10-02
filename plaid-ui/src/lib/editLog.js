// What a person did to a text box, kept as edit operations rather than a new
// body, so a save can say where each change was made (PATCH /texts/:id with
// `edits` and `base`). Each change of the box is read from the value and the
// selection before it and the value and the caret after it, which is what a
// browser reports reliably for every kind of input.
//
// A log is `{ base, digest, ops, raw, body }`: the ops, applied in turn to
// `base`, make `raw`, and `body` is `raw` as the box shows it. `digest` is the
// server's digest of `base`, or null when it is not known yet. Ops are in code
// points of the stored text, as the server counts, while DOM selections are
// UTF-16 of the box's value and are converted here.
//
// A box's value has every line break as `\n`, so a `\r\n` or lone `\r` of the
// stored text is one `\n` in `body`. A change of the box is put onto `raw` at
// the place it stands for: a deleted `\n` deletes the whole stored break, and
// typed text goes in as typed, so no `\r` goes that the user did not delete.
//
// Dependency-free apart from plaid-client's pure modules, reached by path, so
// plaid-ud's node suite can load it.
import { cpLength, utf16ToCp } from '../../../plaid-client-js/src/codepoint.js';
import {
  applyTextOps,
  composeTextEdits,
  gapsToOps,
} from '../../../plaid-client-js/src/textEdits.js';
import { rebaseEdits } from './textMerge.js';

const DEV = Boolean(import.meta.env?.DEV);

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
// Whether UTF-16 index `i` falls between the two halves of an astral letter.
const splitsPair = (s, i) =>
  i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i));

// The one change that turns `prev` into `next`: [s, e) of `prev` gives way to
// next[s, t). UTF-16, never between the halves of an astral letter.
function trimmedChange(prev, next) {
  let s = 0;
  const most = Math.min(prev.length, next.length);
  while (s < most && prev.charCodeAt(s) === next.charCodeAt(s)) s += 1;
  if (splitsPair(prev, s) || splitsPair(next, s)) s -= 1;
  let suf = 0;
  while (
    suf < most - s &&
    prev.charCodeAt(prev.length - 1 - suf) === next.charCodeAt(next.length - 1 - suf)
  ) {
    suf += 1;
  }
  if (splitsPair(prev, prev.length - suf) || splitsPair(next, next.length - suf)) suf -= 1;
  return atWordEdge(prev, next, { s, e: prev.length - suf, t: next.length - suf });
}

const WORD = /[\p{L}\p{M}\p{N}]/u;
// Whether the letter ending at, or starting at, UTF-16 index `i` of `str` is
// part of a word.
const wordBefore = (str, i) => {
  if (i <= 0) return false;
  const back = isLow(str.charCodeAt(i - 1)) && i > 1 ? 2 : 1;
  return WORD.test(String.fromCodePoint(str.codePointAt(i - back)));
};
const wordAfter = (str, i) => i < str.length && WORD.test(String.fromCodePoint(str.codePointAt(i)));

// A pure insert or delete beside text that repeats its own could stand at
// several places, all making `next`: `o t` into `the` or `to ` before it.
// `trimmedChange` finds the last. The first of them, going back from there,
// that splits no word is taken instead, and the last when every one does.
function atWordEdge(prev, next, change) {
  const { s, e, t } = change;
  const insert = s === e && t > s;
  const remove = t === s && e > s;
  if (!insert && !remove) return change;
  const text = insert ? next.slice(s, t) : prev.slice(s, e);
  const clean = (at, value) =>
    insert
      ? !(wordBefore(prev, at) && wordAfter(value, 0)) &&
        !(wordBefore(value, value.length) && wordAfter(prev, at))
      : !(wordBefore(prev, at) && wordAfter(prev, at)) &&
        !(wordBefore(prev, at + value.length) && wordAfter(prev, at + value.length));
  let at = s;
  let value = text;
  for (;;) {
    const end = at + value.length;
    const whole = !splitsPair(prev, at) && !splitsPair(insert ? next : prev, end);
    if (whole && clean(at, value)) {
      return insert ? { s: at, e: at, t: end } : { s: at, e: end, t: at };
    }
    // one unit back: the unit before it the same as its last
    if (at === 0 || prev[at - 1] !== value[value.length - 1]) return change;
    value = prev[at - 1] + value.slice(0, -1);
    at -= 1;
  }
}

// The selection before a change explains it only for what is typed, pasted,
// cut or deleted over that selection. These inputs happen somewhere else: a
// drop and the delete of a drag where the mouse says, an undo or redo where
// the history says, and the selection before them is stale.
const NOT_AT_SELECTION = new Set(['historyUndo', 'historyRedo', 'insertFromDrop', 'deleteByDrag']);

// The change read from a selection that was typed, pasted or deleted over:
// [start, end) of `prev` gave way to next[start, caretAfter). Null when that
// does not make `next`.
function selectionChange(prev, prevSel, next, caretAfter) {
  const ok = (n) => Number.isInteger(n) && n >= 0;
  if (!prevSel || !ok(prevSel.start) || !ok(prevSel.end) || !ok(caretAfter)) return null;
  const { start: s, end: e } = prevSel;
  if (s >= e || e > prev.length || caretAfter < s || caretAfter > next.length) return null;
  if (splitsPair(prev, s) || splitsPair(prev, e) || splitsPair(next, caretAfter)) return null;
  if (prev.slice(0, s) + next.slice(s, caretAfter) + prev.slice(e) !== next) return null;
  return { s, e, t: caretAfter };
}

// The change read from the caret after it, which a browser leaves at the end
// of what it typed, pasted, dropped, put back or redid, and where it deleted:
// the text after the caret is what followed the changed stretch, so the
// stretch ends there, and it starts no later than the first difference from
// the front. What it shares with the old text at its end is trimmed off, so
// a stale caret still gives the least change near it, never a wide one. Null
// when the text after the caret is not the old text's end.
function caretChange(prev, next, caretAfter) {
  if (!Number.isInteger(caretAfter) || caretAfter < 0 || caretAfter > next.length) return null;
  let t = caretAfter;
  let e = prev.length - (next.length - t);
  if (e < 0 || splitsPair(prev, e) || splitsPair(next, t)) return null;
  if (prev.slice(e) !== next.slice(t)) return null;
  let front = 0;
  const most = Math.min(prev.length, next.length);
  while (front < most && prev.charCodeAt(front) === next.charCodeAt(front)) front += 1;
  if (splitsPair(prev, front) || splitsPair(next, front)) front -= 1;
  const s = Math.min(front, e, t);
  while (e > s && t > s && prev.charCodeAt(e - 1) === next.charCodeAt(t - 1)) {
    e -= 1;
    t -= 1;
  }
  if (splitsPair(prev, e) || splitsPair(next, t)) {
    e += 1;
    t += 1;
  }
  return { s, e, t };
}

/**
 * The change of a text box from `prev` to `next` as one running op in code
 * points, or null when nothing changed. `prevSel` is the selection before the
 * change and `caretAfter` the caret after it (the selection's end), both
 * UTF-16 as the DOM gives them, and `inputType` the input event's kind when
 * known. A selection typed or pasted over is the change's place, else the
 * caret is its end (see `caretChange`). With no caret known (a value set by
 * code), the change is the stretch between the common start and end of the
 * two values.
 */
export function inferEdit(prev, prevSel, next, caretAfter, inputType = null) {
  if (prev === next) return null;
  const atSelection = !NOT_AT_SELECTION.has(inputType);
  const { s, e, t } =
    (atSelection && selectionChange(prev, prevSel, next, caretAfter)) ||
    caretChange(prev, next, caretAfter) ||
    trimmedChange(prev, next);
  const index = utf16ToCp(prev, s);
  const length = cpLength(prev.slice(s, e));
  const value = next.slice(s, t);
  if (length === 0) return { type: 'insert', index, value };
  if (value === '') return { type: 'delete', index, value: length };
  return { type: 'replace', index, length, value };
}

// `text` as a text box shows it: every `\r\n` and lone `\r` a `\n`.
const shown = (text) => (text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text);

/** A log of no edits over `base`, whose digest is `digest` (null if not known). */
export function startEditLog(base, digest = null) {
  return { base, digest, ops: [], raw: base, body: shown(base) };
}

// `op`, a change of the box's value `shown(raw)`, as a change of `raw`. Each
// code point of the box stands for one of `raw`, or for a `\r\n`. A `\n`
// typed right after a lone `\r` would make one line break of the two the box
// shows, so the `\r` is then given the `\n` of a `\r\n`.
function onRaw(raw, op) {
  if (!raw.includes('\r')) return op;
  const chars = [...raw];
  const at = [];
  for (let i = 0; i < chars.length; i += 1) {
    at.push(i);
    if (chars[i] === '\r' && chars[i + 1] === '\n') i += 1;
  }
  at.push(chars.length);
  const [length, typed] =
    op.type === 'insert'
      ? [0, op.value]
      : op.type === 'delete'
        ? [op.value, '']
        : [op.length, op.value];
  const start = at[op.index];
  const end = at[op.index + length];
  const joins = chars[start - 1] === '\r' && (typed || chars[end] || '')[0] === '\n';
  const value = joins ? `\n${typed}` : typed;
  if (end === start) return { type: 'insert', index: start, value };
  if (value === '') return { type: 'delete', index: start, value: end - start };
  return { type: 'replace', index: start, length: end - start, value };
}

// Past this many ops, a log keeps its net change instead of every keystroke.
const COMPACT_AT = 128;

// An undo or redo puts the box back to a text it showed before, and the log
// saw that text, so it goes back (or forward) to the state it was in then
// rather than reading the change from the caret, which a browser leaves at
// the start of what it put back for one kind of delete and at the end for
// another. `past` holds the states the log came through, the latest last,
// `future` the ones undone, the next to redo last. Only when no state has
// the box's new text (an undo past a send or a rebase, or past what the log
// keeps) is the change read as any other. At most `HISTORY` states are kept,
// fewer when they hold more than `HISTORY_CHARS` UTF-16 units of text.
const HISTORY = 200;
const HISTORY_CHARS = 8_000_000;
const stateOf = (log) => ({ ops: log.ops, raw: log.raw, body: log.body });
const bounded = (states) => {
  const out = states.length > HISTORY ? states.slice(-HISTORY) : states;
  let size = out.reduce((n, s) => n + s.body.length, 0);
  let drop = 0;
  while (size > HISTORY_CHARS && drop < out.length - 1) {
    size -= out[drop].body.length;
    drop += 1;
  }
  return drop ? out.slice(drop) : out;
};

/**
 * The log with the change from `prev` to `next` recorded (see `inferEdit`).
 * `prev` is what the box showed, which is the log's body. When it is not, the
 * change is read from the body instead, so the log still makes `next`. An
 * undo or redo (`inputType` `historyUndo`, `historyRedo`) takes the log back
 * or forward to the state that had `next`, when it kept one.
 */
export function recordEdit(log, prev, prevSel, next, caretAfter, inputType = null) {
  next = shown(next);
  const past = log.past ?? [];
  const future = log.future ?? [];
  const back = inputType === 'historyUndo';
  if (back || inputType === 'historyRedo') {
    const from = back ? past : future;
    const i = from.findLastIndex((state) => state.body === next);
    if (i >= 0) {
      const passed = [stateOf(log), ...from.slice(i + 1).reverse()];
      const to = [...(back ? future : past), ...passed];
      return back
        ? { ...log, ...from[i], past: from.slice(0, i), future: to }
        : { ...log, ...from[i], past: bounded(to), future: from.slice(0, i) };
    }
  }
  const out = changed(log, prev, prevSel, next, caretAfter, inputType);
  if (out === log) return log;
  return { ...out, past: bounded([...past, stateOf(log)]), future: [] };
}

// The log with the change read from the box (see `inferEdit`).
function changed(log, prev, prevSel, next, caretAfter, inputType) {
  const change =
    prev === log.body
      ? inferEdit(prev, prevSel, next, caretAfter, inputType)
      : inferEdit(log.body, null, next, caretAfter, inputType);
  if (!change) return log;
  const op = onRaw(log.raw, change);
  let ops = [...log.ops, op];
  if (ops.length > COMPACT_AT) ops = gapsToOps(composeTextEdits(log.base, ops));
  // with no `\r` in it, the stored text is the box's
  const raw = log.raw.includes('\r') ? applyTextOps(log.raw, [op]) : next;
  const out = { ...log, ops, raw, body: next };
  if (DEV) assertEditLog(out, op);
  return out;
}

// Development check of the invariant, one step at a time: the box shows the
// text the ops make.
function assertEditLog(log, op) {
  if (shown(log.raw) !== log.body) {
    throw new Error(`editLog: ${JSON.stringify(op)} does not make the box's text`);
  }
}

/** The text the log makes, as the box shows it. */
export const editLogBody = (log) => log.body;

/** The log's net change, as gaps of its base (see plaid-client `composeTextEdits`). */
export const editLogGaps = (log) => composeTextEdits(log.base, log.ops);

/** Whether the log changes nothing. */
export const editLogIsEmpty = (log) => editLogGaps(log).length === 0;

/**
 * Split the log at a send. `sent` is what to send: the base, its digest and
 * the gaps. `rest` is a new log over the text the gaps make, for what is typed
 * while the save is on its way, with its digest unknown until the answer
 * comes (`settleEditLog`). When the save does not land, `unsendEditLog` puts
 * the two back together.
 */
export function sendEditLog(log) {
  return {
    sent: { base: log.base, digest: log.digest, gaps: editLogGaps(log) },
    rest: startEditLog(log.raw, null),
  };
}

/** The log after a send, with the digest of its base from the answer. */
export const settleEditLog = (rest, digest) => ({ ...rest, digest });

/** The sent gaps and the edits made since, as one log over the sent base again. */
export function unsendEditLog(sent, rest) {
  const ops = [...gapsToOps(sent.gaps), ...rest.ops];
  return { base: sent.base, digest: sent.digest, ops, raw: rest.raw, body: rest.body };
}

/**
 * The log moved onto `stored`, the body someone else saved over its base,
 * whose digest is `storedDigest`: a log over `stored` with our changes moved
 * onto it (see `rebaseEdits`), or `{ conflict: true }`.
 */
export function rebaseEditLog(log, stored, storedDigest = null) {
  const result = rebaseEdits(log.base, editLogGaps(log), stored);
  if (result.conflict) return { conflict: true };
  const ops = gapsToOps(result.gaps);
  const raw = applyTextOps(stored, ops);
  return { base: stored, digest: storedDigest, ops, raw, body: shown(raw) };
}

// The gaps that take the text `gaps` make of `base` back to `base`, in code
// points of that text.
function undoGaps(base, gaps) {
  const chars = [...base];
  let shift = 0;
  return gaps.map((g) => {
    const start = g.start + shift;
    const length = cpLength(g.value);
    shift += length - (g.end - g.start);
    return { start, end: start + length, value: chars.slice(g.start, g.end).join('') };
  });
}

/**
 * Whether `stored` holds the change `gaps` make of `base`, whatever else
 * others changed beside it. It does when it is the text they make, when every
 * change of theirs is in it already (`rebaseEdits` leaves none to make), or
 * when taking the change back out can be moved onto it (what changed since
 * lies apart from the change). False when that cannot be told.
 */
export function storedHolds(base, gaps, stored) {
  const mine = applyTextOps(base, gapsToOps(gaps));
  if (stored === mine) return true;
  const moved = rebaseEdits(base, gaps, stored);
  if (!moved.conflict && moved.gaps.length === 0) return true;
  const back = rebaseEdits(mine, undoGaps(base, gaps), stored);
  return !back.conflict && back.gaps.length > 0;
}
