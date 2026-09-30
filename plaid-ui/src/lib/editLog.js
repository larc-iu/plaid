// What a person did to a text box, kept as edit operations rather than a new
// body, so a save can say where each change was made (PATCH /texts/:id with
// `edits` and `base`). Each change of the box is read from the value and the
// selection before it and the value and the caret after it, which is what a
// browser reports reliably for every kind of input.
//
// A log is `{ base, digest, ops, body }`: the ops, applied in turn to `base`,
// make `body`, which is what the box shows. `digest` is the server's digest
// of `base`, or null when it is not known yet. Ops are in code points, as the
// server counts, while DOM selections are UTF-16 and are converted here.
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
  return { s, e: prev.length - suf, t: next.length - suf };
}

// The change read from the caret: the text after it is what followed the old
// selection, so the old stretch ends where that text starts, and it starts
// where the selection or the caret does, whichever is first. Null when that
// reading does not make `next`.
function caretChange(prev, prevSel, next, caretAfter) {
  const ok = (n) => Number.isInteger(n) && n >= 0;
  if (!prevSel || !ok(prevSel.start) || !ok(caretAfter) || caretAfter > next.length) return null;
  const s = Math.min(prevSel.start, caretAfter);
  const e = prev.length - (next.length - caretAfter);
  if (s > e || e > prev.length) return null;
  if (splitsPair(prev, s) || splitsPair(prev, e) || splitsPair(next, caretAfter)) return null;
  if (prev.slice(0, s) + next.slice(s, caretAfter) + prev.slice(e) !== next) return null;
  return { s, e, t: caretAfter };
}

/**
 * The change of a text box from `prev` to `next` as one running op in code
 * points, or null when nothing changed. `prevSel` is the selection before the
 * change and `caretAfter` the caret after it, both UTF-16 as the DOM gives
 * them. When they do not explain the change (undo and redo, a drop, a value
 * set by code, IME composition), the change is the stretch between the common
 * start and end of the two values.
 */
export function inferEdit(prev, prevSel, next, caretAfter) {
  if (prev === next) return null;
  const { s, e, t } = caretChange(prev, prevSel, next, caretAfter) ?? trimmedChange(prev, next);
  const index = utf16ToCp(prev, s);
  const length = cpLength(prev.slice(s, e));
  const value = next.slice(s, t);
  if (length === 0) return { type: 'insert', index, value };
  if (value === '') return { type: 'delete', index, value: length };
  return { type: 'replace', index, length, value };
}

/** A log of no edits over `base`, whose digest is `digest` (null if not known). */
export function startEditLog(base, digest = null) {
  return { base, digest, ops: [], body: base };
}

// Past this many ops, a log keeps its net change instead of every keystroke.
const COMPACT_AT = 128;

/**
 * The log with the change from `prev` to `next` recorded (see `inferEdit`).
 * `prev` is what the box showed, which is the log's body. When it is not, the
 * change is read from the body instead, so the log still makes `next`.
 */
export function recordEdit(log, prev, prevSel, next, caretAfter) {
  const op =
    prev === log.body
      ? inferEdit(prev, prevSel, next, caretAfter)
      : inferEdit(log.body, null, next, null);
  if (!op) return log;
  let ops = [...log.ops, op];
  if (ops.length > COMPACT_AT) ops = gapsToOps(composeTextEdits(log.base, ops));
  const out = { ...log, ops, body: next };
  if (DEV) assertEditLog(out, op, log.body);
  return out;
}

// Development check of the invariant, one step at a time: the new op turns
// the old body into the new one, so the ops applied in turn make the body.
function assertEditLog(log, op, before) {
  if (applyTextOps(before, [op]) !== log.body) {
    throw new Error(`editLog: ${JSON.stringify(op)} does not make the box's text`);
  }
}

/** The text the log makes: its base with its ops applied. */
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
    rest: startEditLog(log.body, null),
  };
}

/** The log after a send, with the digest of its base from the answer. */
export const settleEditLog = (rest, digest) => ({ ...rest, digest });

/** The sent gaps and the edits made since, as one log over the sent base again. */
export function unsendEditLog(sent, rest) {
  const ops = [...gapsToOps(sent.gaps), ...rest.ops];
  return { base: sent.base, digest: sent.digest, ops, body: rest.body };
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
  return { base: stored, digest: storedDigest, ops, body: applyTextOps(stored, ops) };
}
