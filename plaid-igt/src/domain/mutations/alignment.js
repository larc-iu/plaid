// Mutation mixin: time-alignment operations (create/edit/delete alignment,
// align existing baseline text, resize alignment bounds). See IgtDocument.js
// for the `this` API.
//
// Alignment tokens live on a separate `:non-overlapping` token layer; each
// has a character range `[begin, end)` plus `{timeBegin, timeEnd}` metadata
// linking audio/video time to text. Editing the alignment's text also edits
// the body, which triggers the server's text-edit cascade. That cascade is
// mirrored locally (../textEdits.js) so create/edit/delete patch the document
// before the request goes out, a new segment under a pending id: a refetch
// grows with the document and was the lag between Enter and the row
// appearing. A create still falls back to a reload when the server's answer
// lacks the ids, and `_queueWrite` reloads on any failure.
//
// Offsets (token begin/end, text-edit op index/value) are Unicode CODE POINTS,
// so measurement and slicing use cpLength/cpSlice, not the UTF-16
// `.length`/`.substring`/`.indexOf` (which mis-place tokens around astral text).
//
// Every write that changes a segment's text (a new segment, an edited one, a
// segment deleted with its text) goes with `base`, the digest the server gave
// for exactly the body its positions were worked out on. The server refuses it
// with 409 when the body is another one now, and the send then reads the
// document and goes by the segment alone: when the segment is still there and
// still holds the text the edit was made over, the change was elsewhere, and
// the same edit is made again at the segment's place now and sent once more.
// Otherwise nothing is sent and the write is refused with 409 and
// `conflict: { stored, mine }`, which the transcript row shows (Luke's ruling
// Q1). A new segment and a segment deleted with its text go on the raw op
// form. An edit of a segment's text goes as the edits typed in its row, at
// the caret (`editAlignment`), and the segment, which keeps its id, is set
// over its new text in the same batch.

import {
  applyTextOps,
  composeTextEdits,
  cpLength,
  cpSlice,
  gapsToOps,
  mergeMetadata,
  metadataOps,
  createdId,
  createdIds,
  wasReplayed,
} from '@larc-iu/plaid-client';
import { pendingId, settledId } from '@ui/domain/pendingIds.js';
import { isChangedElsewhere, isUnknownOutcome, statusOf } from '@ui/lib/errors.js';
import { inferEdit } from '@ui/lib/editLog.js';
import { applyReshape } from '@ui/domain/textReshape.js';
import { applyGapsLocally, applyTextEditsLocally, removeTokensLocally } from '../textEdits.js';
import { reshapeVocabLinks } from './document.js';
import { getIgtLayerInfo } from '../layerInfo.js';
import { rangeProblem } from '../alignmentTimes.js';
import { notSetUp } from '@ui/domain/setupGuard.js';

// Two ranges [a, b) and [c, d) overlap iff a < d && b > c.
const findOverlappingAlignment = (tokens, begin, end, excludeId = null) =>
  (tokens || []).find((t) => t.id !== excludeId && t.begin < end && t.end > begin) || null;

const sortByBegin = (a, b) => a.begin - b.begin;

// Add a freshly created alignment token to the local layer, in begin order.
const pushAlignmentToken = (infoNext, token) => {
  const layer = infoNext.alignmentTokenLayer;
  if (!layer) return;
  if (!Array.isArray(layer.tokens)) layer.tokens = [];
  layer.tokens.push(token);
  layer.tokens.sort(sortByBegin);
};

// Alignment-token metadata: the time bounds plus an optional speaker label
// (diarization). A blank speaker is omitted so we never persist an empty key.
const alignmentMeta = (timeBegin, timeEnd, speaker) => {
  const meta = { timeBegin, timeEnd };
  const s = (speaker || '').trim();
  if (s) meta.speaker = s;
  return meta;
};

// The stretch of baseline text a segment at [timeBegin, timeEnd) may take
// without breaking the rule that time order follows text order: from the end
// of the last segment that finishes before it to the start of the first one
// that begins after it. Offsets are code points.
export const alignableRange = (tokens, bodyLength, timeBegin, timeEnd) => {
  let leftBoundary = 0;
  let rightBoundary = bodyLength;
  for (const token of tokens || []) {
    const tokenTimeBegin = token.metadata?.timeBegin || 0;
    const tokenTimeEnd = token.metadata?.timeEnd || 0;
    if (tokenTimeEnd <= timeBegin && token.end > leftBoundary) leftBoundary = token.end;
    if (tokenTimeBegin >= timeEnd && token.begin < rightBoundary) rightBoundary = token.begin;
  }
  return { leftBoundary, rightBoundary };
};

// A token at text position `posBegin` with the given `timeBegin` inverts
// temporal order if it would sit earlier in time than its left positional
// neighbor, or later in time than its right one (temporal order must track
// text order). Returns 'previous' | 'next' | null.
const findTemporalInversion = (tokens, posBegin, timeBegin, excludeId = null) => {
  let left = null,
    right = null;
  for (const t of tokens || []) {
    if (t.id === excludeId) continue;
    if (t.begin < posBegin) {
      if (!left || t.begin > left.begin) left = t;
    } else if (t.begin > posBegin) {
      if (!right || t.begin < right.begin) right = t;
    }
  }
  if (left && timeBegin < (left.metadata?.timeBegin ?? -Infinity)) return 'previous';
  if (right && timeBegin > (right.metadata?.timeBegin ?? Infinity)) return 'next';
  return null;
};

const bodyOf = (info) => info.primaryTextLayer?.text?.body ?? '';

// Where a new segment's text goes in the body, so that text order follows time
// order, and the token over it. `{ error }` when it cannot go anywhere, else
// `{ textOps, token: { begin, end }, seedLength }` (see `_showSegmentWrite`).
const planCreate = (info, trimmed, timeBegin) => {
  const existingText = bodyOf(info);
  const alignmentTokens = info.alignmentTokenLayer.tokens || [];
  const sortedTokens = [...alignmentTokens].sort(
    (a, b) => (a.metadata?.timeBegin || 0) - (b.metadata?.timeBegin || 0),
  );

  // Find the temporal neighbors of [timeBegin, timeEnd) so we can choose an
  // insertion offset that preserves temporal ordering on the text axis.
  let insertAfterToken = null;
  let insertBeforeToken = null;
  for (let i = 0; i < sortedTokens.length; i++) {
    const tokenTime = sortedTokens[i].metadata?.timeBegin || 0;
    if (tokenTime <= timeBegin) {
      insertAfterToken = sortedTokens[i];
    } else if (tokenTime > timeBegin && !insertBeforeToken) {
      insertBeforeToken = sortedTokens[i];
      break;
    }
  }

  let insertPosition;
  let temporalInversion = false;
  if (!insertAfterToken && !insertBeforeToken) {
    insertPosition = cpLength(existingText);
  } else if (!insertAfterToken && insertBeforeToken) {
    insertPosition = 0;
  } else if (insertAfterToken && !insertBeforeToken) {
    insertPosition = insertAfterToken.end;
  } else if (insertBeforeToken.begin < insertAfterToken.end) {
    // Temporal/positional ordering conflict. Fall back to inserting
    // before the conflicting later-in-time token.
    insertPosition = insertBeforeToken.begin;
    temporalInversion = true;
  } else {
    insertPosition = insertAfterToken.end;
  }

  let insertedText;
  let insertBegin;
  let tokenBegin;
  let tokenEnd;
  if (insertPosition === 0) {
    const spaceAfter = existingText ? ' ' : '';
    insertedText = trimmed + spaceAfter;
    insertBegin = 0;
    tokenBegin = 0;
    tokenEnd = cpLength(trimmed);
  } else if (insertPosition >= cpLength(existingText)) {
    const spaceBefore = existingText ? ' ' : '';
    insertedText = spaceBefore + trimmed;
    insertBegin = cpLength(existingText);
    tokenBegin = cpLength(existingText) + (spaceBefore ? 1 : 0);
    tokenEnd = tokenBegin + cpLength(trimmed);
  } else {
    const before = cpSlice(existingText, 0, insertPosition);
    const after = cpSlice(existingText, insertPosition);
    const spaceBefore = before.endsWith(' ') ? '' : ' ';
    const spaceAfter = after.startsWith(' ') ? '' : ' ';
    insertedText = spaceBefore + trimmed + spaceAfter;
    insertBegin = insertPosition;
    tokenBegin = insertPosition + (spaceBefore ? 1 : 0);
    tokenEnd = tokenBegin + cpLength(trimmed);
  }

  if (temporalInversion) {
    return {
      error:
        'Cannot add a segment here: it would be out of time order with an existing segment. Delete that segment first.',
    };
  }
  // Overlap must be checked in POST-insert coordinates: the server's text-edit
  // cascade shifts every existing token at/after the insert point right by the
  // inserted length. Projecting first prevents a false "overlap" against a
  // temporal neighbor that the cascade moves clear (bug bash 2026-06-06: a
  // mid-insert between two single-space-separated alignments always tripped it).
  const shiftLen = cpLength(insertedText);
  const projectedTokens = alignmentTokens.map((t) =>
    t.begin >= insertBegin ? { ...t, begin: t.begin + shiftLen, end: t.end + shiftLen } : t,
  );
  if (findOverlappingAlignment(projectedTokens, tokenBegin, tokenEnd)) {
    return { error: 'The new segment overlaps an existing segment.' };
  }

  const newTextLength = cpLength(existingText) + cpLength(insertedText);
  const hasExistingSentences = (info.sentenceTokenLayer.tokens || []).length > 0;
  // Empty partitioning layer: compensate-after-cascade skips it, so we must
  // seed the partition. Otherwise the cascade reindexes surviving sentences
  // to cover the inserted text.
  const seedSentence = !hasExistingSentences && newTextLength > 0;
  return {
    textOps: [{ type: 'insert', index: insertBegin, value: insertedText }],
    token: { begin: tokenBegin, end: tokenEnd },
    seedLength: seedSentence ? newTextLength : null,
  };
};

// The edits that make `trimmed` of `over`, a segment's text, as gaps of it
// (plaid-client `composeTextEdits`). `edits` are the ones typed in its row,
// `{ over, gaps }` (plaid-ui's editLog), taken when they were made over this
// text and make it once the spaces at its ends are trimmed off, which are then
// deleted by gaps of their own. Otherwise, the one change between the two.
const rowGaps = (over, trimmed, edits = null) => {
  if (edits?.over === over && Array.isArray(edits.gaps)) {
    const ops = gapsToOps(edits.gaps);
    const typed = applyTextOps(over, ops);
    if (typed.trim() === trimmed) {
      const lead = cpLength(typed) - cpLength(typed.trimStart());
      const trail = cpLength(typed) - cpLength(typed.trimEnd());
      if (trail) ops.push({ type: 'delete', index: cpLength(typed) - trail, value: trail });
      if (lead) ops.push({ type: 'delete', index: 0, value: lead });
      return composeTextEdits(over, ops);
    }
  }
  const change = inferEdit(over, null, trimmed, null);
  return change ? composeTextEdits(over, [change]) : [];
};

// `segment`'s text changed by `gaps` (of its text) into `trimmed`, and the
// segment over the new text. `{ error }` when the new time or extent would
// break the order or overlap another segment, else `{ gaps }`, the edits in
// the body, `extent`, the segment's new one, and `seedLength` as `planCreate`
// has it. Text typed at the row's front or end says so (`side`), so where the
// row is written against another with no space between, the text rules give
// it to this row's word, and never to the other row's.
const planEdit = (info, segment, gaps, trimmed, timeBegin) => {
  const alignmentTokens = info.alignmentTokenLayer.tokens || [];
  const tokenBegin = segment.begin;
  const tokenEnd = segment.end;
  const newAlignmentEnd = tokenBegin + cpLength(trimmed);
  const body = bodyOf(info);
  const newTextLength = cpLength(body) - (tokenEnd - tokenBegin) + cpLength(trimmed);

  const inversion = findTemporalInversion(alignmentTokens, tokenBegin, timeBegin, segment.id);
  if (inversion) {
    return {
      error: `The new time range would put this segment out of order with the ${inversion} segment.`,
    };
  }

  // Overlap check in POST-edit coordinates: the edit shifts every later token
  // by (newLen - oldLen). Without projecting, growing the text past the next
  // token reads as a false overlap.
  const editDelta = cpLength(trimmed) - (tokenEnd - tokenBegin);
  const projectedTokens = alignmentTokens.map((t) =>
    t.id !== segment.id && t.begin >= tokenEnd
      ? { ...t, begin: t.begin + editDelta, end: t.end + editDelta }
      : t,
  );
  if (findOverlappingAlignment(projectedTokens, tokenBegin, newAlignmentEnd, segment.id)) {
    return { error: 'The edited segment would overlap an existing segment.' };
  }

  const sentences = info.sentenceTokenLayer.tokens || [];
  return {
    gaps: gaps.map((g) => {
      const side =
        g.start !== g.end
          ? null
          : g.start === 0
            ? 'after'
            : g.start === tokenEnd - tokenBegin
              ? 'before'
              : null;
      return {
        ...g,
        start: g.start + tokenBegin,
        end: g.end + tokenBegin,
        ...(side ? { side } : {}),
      };
    }),
    extent: { begin: tokenBegin, end: newAlignmentEnd },
    seedLength: sentences.length === 0 && newTextLength > 0 ? newTextLength : null,
  };
};

// The ops of a row's gaps (plaid-client `gapsToOps`, one op per gap), each
// with the `side` its gap was typed on.
const sidedOps = (gaps) =>
  gapsToOps(gaps).map((op, i) => (gaps[i]?.side ? { ...op, side: gaps[i].side } : op));

// The metadata patch of a row edit: each of the row's keys `mine` sets to
// another value than `was` has (the segment's), and the writer's stamp.
const rowPatch = (mine, was, stamp) => {
  const patch = {};
  for (const key of ROW_KEYS) {
    if (sameRowValue(key, rowValue(mine, key), rowValue(was, key))) continue;
    patch[key] = key === 'speaker' ? mine.speaker || null : rowValue(mine, key);
  }
  return { ...patch, ...(stamp || {}) };
};

// The text delete that takes `segment`'s text with it: the surrounding
// whitespace is swallowed, keeping ONE separator when text survives on both
// sides so the neighbours do not run together. No op for a segment with none.
const planDeleteText = (body, segment) => {
  let beforeText = cpSlice(body, 0, segment.begin);
  let afterText = cpSlice(body, segment.end);
  beforeText = beforeText.replace(/\s+$/, '');
  afterText = afterText.replace(/^\s+/, '');
  const keepSeparator = beforeText && afterText ? 1 : 0;
  const index = cpLength(beforeText) + keepSeparator;
  const numDeleted = cpLength(body) - cpLength(afterText) - index;
  return numDeleted > 0 ? [{ type: 'delete', index, value: numDeleted }] : [];
};

// The ids of the segments `info` holds, settled.
const segmentIds = (info) =>
  new Set((info.alignmentTokenLayer?.tokens || []).map((t) => settledId(t.id)));

// The segment a write names, as the document `info` holds it now: by its id,
// settled, since the write may have been made while it was pending. Null when
// it is gone. A segment someone else made is never taken for it, whatever its
// speaker and times: a write goes only onto the segment it was made on.
const segmentNow = (info, id) =>
  (info.alignmentTokenLayer?.tokens || []).find((t) => settledId(t.id) === settledId(id)) ?? null;

// The entity rule for a write over one segment's text, on the document as
// read after a refusal: the segment is still there and still holds `over`,
// the text the write was made over, and the write goes again on `segment`.
// The segment holding `mine` already is the write landed (someone typed the
// same): `{ landed: true }`. Otherwise the conflict to refuse with, `{ stored,
// mine }`, `stored` null when the segment is gone. `segment` is the segment
// found, if any.
const segmentConflict = (info, id, over, mine) => {
  const segment = segmentNow(info, id);
  if (!segment) return { conflict: { stored: null, mine }, segment };
  const stored = cpSlice(bodyOf(info), segment.begin, segment.end);
  if (stored === over) return { segment };
  if (mine && stored === mine) return { landed: true, segment };
  return { conflict: { stored, mine }, segment };
};

// What a transcript row writes of a segment's metadata beside its text.
const ROW_KEYS = ['timeBegin', 'timeEnd', 'speaker'];

// A row key of segment metadata `m` as the row reads and sends it: a
// missing start is 0, a missing end is the start, and a blank speaker is none.
const rowValue = (m, key) => {
  const begin = m?.timeBegin ?? 0;
  if (key === 'timeBegin') return begin;
  if (key === 'timeEnd') return m?.timeEnd ?? begin;
  return m?.[key] || null;
};

// Two values of a row key the same: times within a millisecond.
const sameRowValue = (key, a, b) => (key === 'speaker' ? a === b : Math.abs(a - b) < 0.001);

// The metadata a segment made again after a refusal goes with: `mine`, the
// metadata the write was planned with, except for each of the row's keys it
// did not change from `was` (the segment's when the write was made), which
// takes the value stored now, `now`. So a speaker or a time someone else set
// meanwhile stays, and one this write set is written. Null when both changed
// the same key to different values: the write is refused as a conflict. The
// values are compared as the row reads them (`rowValue`).
const replannedMetadata = (mine, was = {}, now = {}) => {
  const out = { ...mine };
  for (const key of ROW_KEYS) {
    const [ours, before, stored] = [mine, was, now].map((m) => rowValue(m, key));
    if (!sameRowValue(key, ours, before)) {
      if (!sameRowValue(key, stored, before) && !sameRowValue(key, stored, ours)) return null;
      continue;
    }
    if (now?.[key] == null || now[key] === '') delete out[key];
    else out[key] = now[key];
  }
  return out;
};

/**
 * A write refused because its Idempotency-Key was sent before with another
 * request (422 `idempotency-key-reused`): a run of a send whose earlier run
 * landed, with its answer lost, and planned again since. What it wrote is
 * read back.
 */
export const isKeyReused = (error) =>
  statusOf(error) === 422 && error?.responseData?.error === 'idempotency-key-reused';

/**
 * Run `fn`, the requests of one plan of a write, as an operation under the
 * key seed `keys` (plaid-client `keySeed`), numbered from 0 inside the write's
 * own operation. A send run again after its answer was lost sends each plan
 * it made again under that plan's keys, and a request that landed is answered
 * from what it stored. Without keys (a client that has none), `fn` alone.
 */
export const underKeys = (client, keys, fn) =>
  keys ? client.withOperation(null, fn, { keys }) : fn();

// A segment write refused without being sent (again): the body changed under
// it where it writes. A 409, as the server's own refusal is, so every screen
// takes it as changed elsewhere.
const textConflict = (conflict) =>
  Object.assign(new Error('HTTP 409 The text was changed since it was read.'), {
    status: 409,
    conflict,
  });

export const alignmentMutations = {
  // Create a new alignment by inserting `text` into the body at a position
  // chosen to preserve temporal ordering, then creating the alignment token
  // over the inserted range with `{timeBegin, timeEnd}` metadata.
  async createAlignment({ text, timeBegin, timeEnd, speaker }) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      this.setError('Segment text is required');
      return false;
    }
    if (timeEnd < timeBegin) {
      this.setError('Invalid time range: end must be at or after start');
      return false;
    }
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;
    if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
      this.setError(notSetUp('Required layers not found'));
      return false;
    }
    const textId = primaryTextLayer.text?.id;
    if (!textId) {
      this.setError(notSetUp('Text layer not found'));
      return false;
    }

    const plan = planCreate(info, trimmed, timeBegin);
    if (plan.error) {
      this.setError(plan.error);
      return false;
    }
    const meta = { ...alignmentMeta(timeBegin, timeEnd, speaker), ...(this.createStamp || {}) };

    // A refused insert is made again where the segment goes in the body as
    // stored, when it still fits there. It only adds text, so it overwrites
    // nothing.
    const replan = (fresh) => {
      const again = planCreate(fresh, trimmed, timeBegin);
      return again.error ? { conflict: null } : { plan: again };
    };
    return this._showSegmentWrite('Failed to create alignment', {
      textId,
      ...plan,
      metadata: meta,
      speaker,
      replan,
    });
  },

  // Change a segment's text, from its transcript row: `text` the row's new
  // text, and `edits` the changes typed in it (`rowGaps`). They are saved as
  // edits at the caret with the digest of the body they were made on
  // (`_showRowEdit`), and the segment is set over the new text, so it keeps
  // its id, and the words inside keep what the text rules keep of them. The
  // times and the speaker are written only where they differ from the
  // segment's, with the writer's stamp.
  async editAlignment(existingAlignmentId, { text, timeBegin, timeEnd, speaker, edits = null }) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      this.setError('Segment text is required');
      return false;
    }
    if (timeEnd < timeBegin) {
      this.setError('Invalid time range: end must be at or after start');
      return false;
    }
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;
    if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
      this.setError(notSetUp('Required layers not found'));
      return false;
    }
    const textId = primaryTextLayer.text?.id;
    if (!textId) {
      this.setError(notSetUp('Text layer not found'));
      return false;
    }
    const alignmentTokens = alignmentTokenLayer.tokens || [];
    const existingAlignment = alignmentTokens.find((t) => t.id === existingAlignmentId);
    if (!existingAlignment) {
      this.setError('Segment not found');
      return false;
    }

    // What the edit changes, for the entity rule when it is refused.
    const over = cpSlice(this.body, existingAlignment.begin, existingAlignment.end);
    const gaps = rowGaps(over, trimmed, edits);
    const mine = alignmentMeta(timeBegin, timeEnd, speaker);
    const was = existingAlignment.metadata;
    if (!gaps.length) {
      // Only spaces were typed: what else the row changed, or nothing.
      const s = (speaker || '').trim();
      return s === (was?.speaker || '')
        ? true
        : this.updateAlignmentSpeaker(existingAlignmentId, s);
    }
    const plan = planEdit(info, existingAlignment, gaps, trimmed, timeBegin);
    if (plan.error) {
      this.setError(plan.error);
      return false;
    }

    // Made again over the segment as stored: a speaker or a time someone else
    // set meanwhile is a change to another field of it, and stays, since only
    // the keys this edit changed are written. The same field changed on both
    // sides is a conflict.
    const replan = (fresh) => {
      const found = segmentConflict(fresh, existingAlignmentId, over, trimmed);
      if (!found.segment || found.conflict || found.landed) return found;
      if (!replannedMetadata(mine, was, found.segment.metadata)) {
        return { conflict: { stored: over, mine: trimmed } };
      }
      const again = planEdit(fresh, found.segment, gaps, trimmed, timeBegin);
      return again.error
        ? { conflict: { stored: over, mine: trimmed } }
        : {
            plan: { ...again, patch: rowPatch(mine, was, this.editStamp(found.segment.metadata)) },
          };
    };

    return this._showRowEdit('Failed to edit alignment', {
      textId,
      segmentId: existingAlignmentId,
      ...plan,
      typed: trimmed,
      patch: rowPatch(mine, was, this.editStamp(was)),
      speaker,
      replan,
    });
  },

  // Make a segment over text already in the baseline: no character changes,
  // one token is created over `[begin, end)` (code points into the body). The
  // range has to lie in the stretch a segment at this time may take (between
  // the segment before it in time and the one after, see `alignableRange`)
  // and may not overlap another segment.
  async alignBaseline({ begin, end, timeBegin, timeEnd, speaker }) {
    if (timeEnd < timeBegin) {
      this.setError('Invalid time range: end must be at or after start');
      return false;
    }
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;
    if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
      this.setError(notSetUp('Required layers not found'));
      return false;
    }
    const textId = primaryTextLayer.text?.id;
    if (!textId) {
      this.setError(notSetUp('Text layer not found'));
      return false;
    }

    const fullText = this.body;
    const bodyLength = cpLength(fullText);
    const inRange =
      Number.isInteger(begin) &&
      Number.isInteger(end) &&
      begin >= 0 &&
      begin < end &&
      end <= bodyLength;
    if (!inRange || !cpSlice(fullText, begin, end).trim()) {
      this.setError('Select the text this segment covers.');
      return false;
    }

    const alignmentTokens = alignmentTokenLayer.tokens || [];
    const { leftBoundary, rightBoundary } = alignableRange(
      alignmentTokens,
      bodyLength,
      timeBegin,
      timeEnd,
    );
    if (begin < leftBoundary || end > rightBoundary) {
      this.setError(
        'The selected text lies outside what this time range can cover: a neighboring segment would fall out of time order. Adjust the time range or the neighboring segments.',
      );
      return false;
    }
    if (findOverlappingAlignment(alignmentTokens, begin, end)) {
      this.setError('The selected text overlaps an existing segment.');
      return false;
    }

    const meta = { ...alignmentMeta(timeBegin, timeEnd, speaker), ...(this.createStamp || {}) };
    return this._showSegmentWrite('Failed to align baseline text', {
      textId,
      textOps: [],
      token: { begin, end },
      metadata: meta,
      seedLength: null,
      speaker,
    });
  },

  // Delete a segment. By default only the segment goes and its text stays in
  // the baseline, words and annotations included. With `deleteText` its text
  // is deleted too and the cascade takes the token; the surrounding whitespace
  // is swallowed, keeping ONE separator when text survives on both sides so
  // the neighbours do not run together. Either way the document is patched
  // before the request goes out, so the row leaves at once; a failure reloads.
  async deleteAlignment(alignmentId, { deleteText = false } = {}) {
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    if (!primaryTextLayer || !alignmentTokenLayer) {
      this.setError(notSetUp('Required layers not found'));
      return false;
    }
    const textId = primaryTextLayer.text?.id;
    if (!textId) {
      this.setError(notSetUp('Text layer not found'));
      return false;
    }
    const existingAlignment = (alignmentTokenLayer.tokens || []).find((t) => t.id === alignmentId);
    if (!existingAlignment) {
      this.setError('Segment not found');
      return false;
    }

    const label = 'Failed to delete segment';
    if (!this._canWrite(label)) return false;
    if (!deleteText) {
      this._applyRawPatch((next, infoNext, vocabs) => {
        removeTokensLocally(next, textId, [alignmentId], vocabs);
      });
      return this._queueWrite(label, () => this._client.tokens.delete(settledId(alignmentId)));
    }

    const textOps = planDeleteText(this.body, existingAlignment);
    // What the delete takes, for the entity rule when it is refused.
    const over = cpSlice(this.body, existingAlignment.begin, existingAlignment.end);
    const planned = this._plannedText();

    // The segment is deleted in its own right, then its text. It used to go
    // through the text edit alone, on the strength of the server's cascade
    // (a token inside a deleted stretch goes with it), which holds for a
    // segment with text and fails for one with none: nothing to delete, no
    // cascade, and the segment the person had just confirmed deleting was
    // still there. The first real user found it on her empty segments. The
    // two go in one batch, so a text refused as changed deletes nothing.
    const show = (id, ops) => (next, infoNext, vocabs) => {
      removeTokensLocally(next, textId, [id], vocabs);
      if (ops.length) applyTextEditsLocally(next, textId, ops, vocabs);
    };
    this._applyRawPatch(show(alignmentId, textOps));
    const send = (id, ops, base) =>
      this._client.batched(async (b) => {
        b.tokens.delete(settledId(id));
        if (ops.length) b.texts.update(textId, ops, undefined, { base });
      });
    // What is sent, kept outside the send (see `_sendOverSegmentText`).
    const state = { planned, send: (base) => send(alignmentId, textOps, base) };
    return this._queueWrite(label, async () => {
      if (!textOps.length) {
        await this._client.tokens.delete(settledId(alignmentId));
        return;
      }
      const results = await this._sendOverSegmentText(state, {
        // Sent again only over the segment as it was: a text changed
        // meanwhile is refused, and the row comes back with it.
        replan: (fresh, updated) => {
          const found = segmentConflict(fresh, alignmentId, over, '');
          if (found.conflict) return { conflict: found.conflict };
          const { segment } = found;
          const ops = planDeleteText(bodyOf(fresh), segment);
          return {
            send: (base) => send(segment.id, ops, base),
            show: () => this._showRead(updated, show(segment.id, ops)),
          };
        },
        // A delete whose key was sent before with another request: it
        // landed when the segment is gone.
        landed: (fresh) => !segmentIds(fresh).has(settledId(alignmentId)),
      });
      this._heardText(textId, results?.[1]?.body);
      // A replayed answer (this send run again, or the client's own resend)
      // carries the body as it was: what is stored is read once the queue has
      // drained.
      if (state.again || wasReplayed(results)) this._writes.reloadWhenDrained = true;
    });
  },

  // Delete several segments at once, times and speakers only: their text stays
  // in the baseline. One operation, mirrored locally rather than reloaded.
  async deleteAlignments(ids) {
    const info = this.layerInfo;
    const textId = info.primaryTextLayer?.text?.id;
    const have = new Set((info.alignmentTokenLayer?.tokens || []).map((t) => t.id));
    const wanted = [...new Set(ids)].filter((id) => have.has(id));
    if (!textId || !wanted.length) return false;
    const label = 'Failed to delete segments';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next, infoNext, vocabs) => {
      removeTokensLocally(next, textId, wanted, vocabs);
    });
    return this._queueWrite(label, () => this._client.tokens.bulkDelete(wanted.map(settledId)));
  },

  // Resize: just metadata. No text edit, no cascade. Patches the alignment's
  // metadata in place.
  async updateAlignmentBounds(alignmentId, { timeBegin, timeEnd }) {
    const info = this.layerInfo;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    const token = (alignmentTokenLayer?.tokens || []).find((t) => t.id === alignmentId);
    if (!token) {
      this.setError('Segment not found');
      return false;
    }
    if (timeEnd < timeBegin) {
      this.setError('Invalid time range: end must be at or after start');
      return false;
    }
    // Bounds are metadata-only with no _reload, so a temporal/positional
    // inversion here would persist silently. Guard it like createAlignment does.
    const inversion = findTemporalInversion(
      alignmentTokenLayer?.tokens || [],
      token.begin,
      timeBegin,
      alignmentId,
    );
    if (inversion) {
      this.setError(
        `The new time range would put this segment out of order with the ${inversion} segment.`,
      );
      return false;
    }

    // In time the only rule is cross-talk: a segment may overlap another only
    // when both are labelled with different speakers.
    const problem = rangeProblem(
      alignmentTokenLayer?.tokens || [],
      alignmentId,
      timeBegin,
      timeEnd,
      {
        minWidth: 0,
        format: (s) => `${s.toFixed(3)} s`,
      },
    );
    if (problem) {
      this.setError(problem);
      return false;
    }

    const label = 'Failed to update alignment boundaries';
    if (!this._canWrite(label)) return false;
    // PATCH (shallow-merge), not setMetadata (full replace): a manual boundary
    // drag must preserve the segment's provenance (prov/provSource/provDetail),
    // and per the cross-app convention a person's edit carries the writer's
    // stamp (write-contract rule 3: a verifier's confirms a machine-made or
    // contributed segment, a contributor's marks it contributed). setMetadata
    // would wipe prov, recording a machine-made segment as origin-less.
    const patch = { timeBegin, timeEnd, ...(this.editStamp(token.metadata) || {}) };
    this._applyRawPatch((next, infoNext) => {
      const t = (infoNext.alignmentTokenLayer?.tokens || []).find((x) => x.id === alignmentId);
      if (t) t.metadata = mergeMetadata(t.metadata, patch);
    });
    return this._queueWrite(label, () =>
      this._client.tokens.patchMetadata(settledId(alignmentId), metadataOps(patch)),
    );
  },

  // Speaker-only edit (diarization): patch just the `speaker` label on an
  // alignment token. No text edit, no cascade, no token churn — so relabeling a
  // segment's speaker never rewrites the baseline or the sentence partition and
  // never changes the token id. A blank value clears the label (a delete op).
  async updateAlignmentSpeaker(alignmentId, speaker) {
    const info = this.layerInfo;
    const token = (info.alignmentTokenLayer?.tokens || []).find((t) => t.id === alignmentId);
    if (!token) {
      this.setError('Segment not found');
      return false;
    }
    const value = (speaker || '').trim();
    const label = 'Failed to update speaker';
    if (!this._canWrite(label)) return false;
    // A person's edit carries the writer's stamp (write-contract rule 3), and
    // choosing a segment's speaker is one. A blank clears it (a delete op).
    const patch = { speaker: value || null, ...(this.editStamp(token.metadata) || {}) };
    this._applyRawPatch((next, infoNext) => {
      const t = (infoNext.alignmentTokenLayer?.tokens || []).find((x) => x.id === alignmentId);
      if (t) t.metadata = mergeMetadata(t.metadata, patch);
    });
    return this._queueWrite(label, async () => {
      await this._client.tokens.patchMetadata(settledId(alignmentId), metadataOps(patch));
      await this._rememberSpeaker(value);
    });
  },

  // Delete every alignment token. No text edit; alignments live on their own
  // layer and don't partition the body.
  async clearAlignments() {
    const info = this.layerInfo;
    const textId = info.primaryTextLayer?.text?.id;
    const alignmentTokens = info.alignmentTokenLayer?.tokens || [];
    if (alignmentTokens.length === 0) return false;
    const label = 'Failed to clear alignments';
    if (!this._canWrite(label)) return false;
    const ids = alignmentTokens.map((t) => t.id);
    this._applyRawPatch((next, infoNext, vocabs) => removeTokensLocally(next, textId, ids, vocabs));
    return this._queueWrite(label, () => this._client.tokens.bulkDelete(ids.map(settledId)));
  },

  // A segment written with a text edit or over text already there, shown at
  // once: the edit mirrored locally (textEdits.js), the segment under a
  // pending id, and a first sentence under another when the edit leaves the
  // partition empty (`seedLength`, the body's new length). The segment and
  // the sentence are made in ONE batch with the text edit. `replan(fresh)`
  // makes the write again on the layers of the document as stored, after a
  // refusal: `{ plan }` to send (with its own `metadata` when it differs),
  // or `{ conflict }` to refuse with.
  _showSegmentWrite(label, { textId, textOps, token, metadata, seedLength, speaker, replan }) {
    if (!this._canWrite(label)) return false;
    const info = this.layerInfo;
    const alignmentLayerId = info.alignmentTokenLayer.id;
    const sentenceLayerId = info.sentenceTokenLayer.id;
    const planned = this._plannedText();
    // A write made again after a refusal keeps the ids it showed: the rows
    // were never made, and an edit queued behind it names them.
    const made = (plan, before = null) => ({
      textOps: plan.textOps,
      segment: {
        id: before?.segment.id ?? pendingId(),
        text: textId,
        ...plan.token,
        metadata: plan.metadata ?? metadata,
      },
      seeded:
        plan.seedLength != null
          ? { id: before?.seeded?.id ?? pendingId(), text: textId, begin: 0, end: plan.seedLength }
          : null,
    });
    const show = (m) => (next, infoNext, vocabs) => {
      if (m.textOps.length) applyTextEditsLocally(next, textId, m.textOps, vocabs);
      pushAlignmentToken(infoNext, { ...m.segment });
      if (m.seeded) infoNext.sentenceTokenLayer.tokens = [{ ...m.seeded }];
    };
    const send = (m, base) =>
      this._client.batched(async (b) => {
        // The text write claims the document's version beside its base: a
        // batch checks the version at the first write that claims one, and
        // the token after it claims the version from before the batch.
        if (m.textOps.length) {
          b.texts.update(textId, m.textOps, undefined, { base, versioned: true });
        }
        // Under the ids shown, so a resend of a lost answer names the same rows.
        b.tokens.create(
          alignmentLayerId,
          textId,
          m.segment.begin,
          m.segment.end,
          undefined,
          m.segment.metadata,
          undefined,
          { id: m.segment.id },
        );
        if (m.seeded) {
          b.tokens.bulkCreate([
            {
              id: m.seeded.id,
              tokenLayerId: sentenceLayerId,
              text: textId,
              begin: 0,
              end: m.seeded.end,
            },
          ]);
        }
      });
    let sent = made({ textOps, token, seedLength });
    this._applyRawPatch(show(sent));
    // What is sent, kept outside the send (see `_sendOverSegmentText`).
    const state = { planned, send: (base) => send(sent, base) };
    return this._queueWrite(label, async () => {
      const results = !textOps.length
        ? await send(sent)
        : await this._sendOverSegmentText(state, {
            replan: (fresh, updated) => {
              const again = replan(fresh);
              if (!again.plan) return again;
              const m = made(again.plan, sent);
              sent = m;
              return {
                send: (base) => send(m, base),
                show: () => this._showRead(updated, show(m)),
              };
            },
            // A write whose key was sent before with another request, or
            // refused after the client sent it again: it landed when the
            // segment it makes is there.
            landed: (fresh) => segmentIds(fresh).has(settledId(sent.segment.id)),
            readOnRefusal: true,
          });
      const at = sent.textOps.length ? 1 : 0;
      if (at) this._heardText(textId, results?.[0]?.body);
      const ids = new Map([[sent.segment.id, createdId(results?.[at])]]);
      if (sent.seeded) ids.set(sent.seeded.id, createdIds(results?.[at + 1])[0]);
      if ([...ids.values()].some((id) => !id)) {
        await this._reloadInSend(); // the batch answered without the ids the patch needs
      } else {
        this._settle(ids);
        // A replayed answer (this send run again, or the client's own resend)
        // carries the body as it was when the write first landed: what is
        // stored now is read once the queue has drained.
        if (state.again || wasReplayed(results)) this._writes.reloadWhenDrained = true;
      }
      await this._rememberSpeaker(speaker);
    });
  },

  // A segment's text changed by a row edit, shown at once: the edits shown
  // on the body (textEdits.js `applyGapsLocally`, which deletes nothing), the
  // segment set over its new text with its metadata patched, and a first
  // sentence when there is none (`seedLength`). The edits go as edits at the
  // caret with the digest of the body they were planned on, in ONE batch
  // with the segment's new extent, its metadata and the sentence. What the
  // edit did to the words inside is the server's to say: the answer's
  // `reshape` is shown (`_showRowAnswer`). A segment typed over whole keeps
  // its token, since the text rules keep a token holding the stretch typed
  // over (`plainEdits`). `replan(fresh)`
  // is as `_showSegmentWrite` has it, its plan with its own `patch`.
  _showRowEdit(
    label,
    { textId, segmentId, gaps, extent, typed, seedLength, patch, speaker, replan },
  ) {
    if (!this._canWrite(label)) return false;
    const info = this.layerInfo;
    const sentenceLayerId = info.sentenceTokenLayer.id;
    const planned = this._plannedText();
    const made = (plan, before = null) => ({
      gaps: plan.gaps,
      extent: plan.extent,
      patch: plan.patch ?? patch,
      seeded:
        plan.seedLength != null
          ? { id: before?.seeded?.id ?? pendingId(), end: plan.seedLength }
          : null,
      // The tokens the edit moved on screen, the last time it was shown.
      changed: new Set(),
    });
    const show = (m) => (next, infoNext) => {
      m.changed = applyGapsLocally(next, textId, m.gaps);
      const segment = (infoNext.alignmentTokenLayer?.tokens || []).find(
        (t) => settledId(t.id) === settledId(segmentId),
      );
      if (segment) {
        segment.begin = m.extent.begin;
        segment.end = m.extent.end;
        segment.metadata = mergeMetadata(segment.metadata, m.patch);
      }
      if (m.seeded) {
        infoNext.sentenceTokenLayer.tokens = [
          { id: m.seeded.id, text: textId, begin: 0, end: m.seeded.end },
        ];
      }
    };
    // Answers where in the batch's results the last text write and the
    // sentences are.
    const send = (m, base) => {
      const id = settledId(segmentId);
      const at = {};
      return this._client
        .batched(async (b) => {
          const patched = Object.keys(m.patch).length > 0;
          b.texts.edit(textId, sidedOps(m.gaps), undefined, { base, versioned: true });
          b.tokens.update(id, m.extent.begin, m.extent.end);
          at.text = 0;
          if (patched) b.tokens.patchMetadata(id, metadataOps(m.patch));
          if (m.seeded) {
            b.tokens.bulkCreate([
              {
                id: m.seeded.id,
                tokenLayerId: sentenceLayerId,
                text: textId,
                begin: 0,
                end: m.seeded.end,
              },
            ]);
            at.seeded = 2 + (patched ? 1 : 0);
          }
        })
        .then((results) => Object.assign(results, { at }));
    };
    let sent = made({ gaps, extent, seedLength });
    this._applyRawPatch(show(sent));
    const state = { planned, send: (base) => send(sent, base) };
    return this._queueWrite(label, async () => {
      const results = await this._sendOverSegmentText(state, {
        replan: (fresh, updated) => {
          const again = replan(fresh);
          if (!again.plan) return again;
          const m = made(again.plan, sent);
          sent = m;
          return {
            send: (base) => send(m, base),
            show: () => this._showRead(updated, show(m)),
          };
        },
        // A write whose key was sent before with another request, or refused
        // after the client sent it again: it landed when its segment holds its
        // text.
        landed: (fresh) => {
          const segment = segmentNow(fresh, segmentId);
          return !!segment && cpSlice(bodyOf(fresh), segment.begin, segment.end) === typed;
        },
        readOnRefusal: true,
      });
      if (!results) return; // found stored already
      const at = results.at ?? {};
      const answer = results[at.text ?? 0]?.body;
      this._heardText(textId, answer);
      if (sent.seeded) {
        const made = createdIds(results[at.seeded])[0];
        if (made) this._settle(new Map([[sent.seeded.id, made]]));
      }
      // A replayed answer (this send run again, or the client's own resend)
      // carries the body as it was when the write first landed: what is
      // stored now is read once the queue has drained.
      if (state.again || wasReplayed(results)) {
        this._writes.reloadWhenDrained = true;
      } else {
        this._showRowAnswer(textId, segmentId, sent, answer);
      }
      await this._rememberSpeaker(speaker);
    });
  },

  // The answer to a row edit's text write shown: what it did to the tokens
  // and what hangs off them (plaid-ui `applyReshape`), and the segment over
  // the extent the batch set after it. Only when the page shows exactly the
  // body the answer has, with no edit queued behind, and every token the
  // edit moved on screen is one the answer names. Otherwise the document is
  // read once the queue has drained.
  _showRowAnswer(textId, segmentId, sent, answer) {
    const reshape = answer?.reshape;
    const text = this.layerInfo.primaryTextLayer?.text;
    const named = new Set([
      ...(reshape?.tokens ?? []).map((t) => t.id),
      ...(reshape?.deleted?.tokens ?? []),
      settledId(segmentId),
    ]);
    const guessed = [...sent.changed].some((id) => !named.has(settledId(id)));
    if (!reshape || guessed || this._writes.queued > 1 || text?.body !== answer.body) {
      this._writes.reloadWhenDrained = true;
      return;
    }
    this._applyRawPatch((next, infoNext, vocabs) => {
      Object.assign(next, applyReshape(next, textId, answer));
      reshapeVocabLinks(vocabs, reshape);
      const segment = (getIgtLayerInfo(next).alignmentTokenLayer?.tokens || []).find(
        (t) => settledId(t.id) === settledId(segmentId),
      );
      if (segment) {
        segment.begin = sent.extent.begin;
        segment.end = sent.extent.end;
      }
    });
  },

  // The body the next text write is planned on, as this copy has it now, and
  // the digest the server gave for exactly that body. The digest is null when
  // an edit made here since changed the body (textEdits.js), until the
  // server's answer to it gives the new one (`_heardText`).
  _plannedText() {
    const text = this.layerInfo.primaryTextLayer?.text;
    return { body: text?.body ?? '', digest: text?.digest ?? null };
  },

  // The `base` for a write planned on `planned`, at the moment it is sent:
  // the digest read with that body, else the one the server answered the last
  // text write here with, when that write left exactly that body. The write
  // queue sends in order, so a write made while the one before it was on its
  // way was planned on the body that one makes. Null when neither is known.
  _segmentBase(planned) {
    if (planned.digest) return planned.digest;
    const heard = this._lastText;
    return heard && heard.body === planned.body ? heard.digest : null;
  },

  // The server's answer to a text write: the body it stored and its digest.
  // The copy on screen takes the digest when its body is that body (no edit
  // made since is shown on top of it). The same patch shown again over a
  // later read sets it only on the same body, whose digest it is.
  _heardText(textId, answer) {
    const { body, digest } = answer ?? {};
    if (typeof body !== 'string' || typeof digest !== 'string') return;
    this._lastText = { body, digest };
    const text = this.layerInfo.primaryTextLayer?.text;
    if (text?.id !== textId || text.body !== body || text.digest === digest) return;
    this._applyRawPatch((next) => {
      const text = (next.textLayers || []).find((tl) => tl.text?.id === textId)?.text;
      if (text && text.body === body) text.digest = digest;
    });
  },

  // Send a write over one segment's text. `state` is what is sent, kept by
  // the caller outside its send, so a send run again after its answer was lost
  // (the queue sends it again until it is answered) sends exactly
  // the request that was lost, under the same keys, and is answered from what
  // it stored:
  // - `planned`: the body the write was planned on and its digest.
  // - `send(base)`: the write, with the digest of that body.
  // - `base` and `keys`, set here: the digest it goes with and the key seed
  //   of its requests (`underKeys`). A plan made again takes new keys.
  // - `again`, set here: the request was sent under these keys before, so
  //   its answer may be the first one's, replayed, with the body as it was
  //   then. The caller has the document read once the queue has drained.
  //
  // When the server refuses it as changed elsewhere (409, or a row it names is
  // gone), or that body's digest is not known, the document is read, put on
  // screen with the edits queued behind shown on top, and
  // `replan(fresh, updated)` goes by the segment on it (`fresh` its layers):
  // `{ conflict }` refuses the write unsent, `{ landed: true }` finds it
  // stored already, and anything else is the write made again, whose `show()`
  // puts it on screen and whose `send(base)` goes once, with the digest read.
  // A request refused because its key was sent before with another one is read
  // back too: `landed(fresh)` says whether the write is stored, and otherwise
  // it is made again. With `readOnRefusal`, any other refusal is read back
  // the same way: a send under these keys may have landed with its answer
  // lost, sent by the client inside its own resend, whatever the refusal of
  // the resend says (a 500, a 403), and it has when `landed(fresh)`. Answers
  // the batch's results, null when it was found stored.
  async _sendOverSegmentText(state, { replan, landed = null, readOnRefusal = false }) {
    if (!state.keys) {
      state.base = this._segmentBase(state.planned);
      state.keys = this._client.keySeed?.() ?? null;
    } else {
      state.again = true;
    }
    let reused = false;
    if (state.base) {
      try {
        return await underKeys(this._client, state.keys, () => state.send(state.base));
      } catch (err) {
        reused = isKeyReused(err);
        if (!reused && !isChangedElsewhere(err)) {
          if (!readOnRefusal || !landed || isUnknownOutcome(err)) throw err;
          let updated;
          try {
            updated = await this._fetch();
          } catch {
            throw err;
          }
          if (!landed(getIgtLayerInfo(updated))) throw err;
          await this._adoptReload(updated);
          this._showRead(updated);
          return null;
        }
      }
    }
    const updated = await this._fetch();
    await this._adoptReload(updated);
    const fresh = getIgtLayerInfo(updated);
    const again = reused && landed?.(fresh) ? { landed: true } : replan(fresh, updated);
    if (again.landed) {
      this._showRead(updated);
      return null;
    }
    if ('conflict' in again) {
      this._showRead(updated);
      throw textConflict(again.conflict);
    }
    again.show();
    state.send = again.send;
    state.base = fresh.primaryTextLayer?.text?.digest ?? null;
    state.keys = this._client.keySeed?.() ?? null;
    state.again = false;
    return underKeys(this._client, state.keys, () => state.send(state.base));
  },

  // From inside a send: `updated`, just read, on screen, with `producer` (the
  // write being made again) and then the edits queued behind shown on top, as
  // `_reloadInSend` does.
  _showRead(updated, producer = null) {
    this._showUnsent(producer ? this._patched(updated, producer) : updated);
    if (this._writes.queued > 1) this._writes.reloadWhenDrained = true;
  },
};
