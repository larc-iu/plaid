// A local mirror of the server's text-edit cascade, so an edit to the baseline
// can patch the document in place instead of refetching it. A full document
// GET grows with the document (1.6s for a 420-sentence text on the dev server),
// and the transcript flow saves on every Enter, so the refetch WAS the lag.
//
// The rules are transcribed from plaid-core: `plaid.algos.text/apply-text-edit`
// (how each token's extent follows an insert or a delete, zero-width tokens
// pinned) and `plaid.sql.token/compensate-partition-layers!` (a partitioning
// layer with survivors is stretched back into a gapless cover of the new body).
// The server runs the same two steps in the same order, so a client that
// applies them to the same starting state lands on the same tokens. Keep the
// two in step: a change to either server function is a change here.
//
// Offsets are Unicode code points throughout, like the tokens they move.

import { cpLength, cpSlice } from '@larc-iu/plaid-client';

/** Token extents after inserting `count` code points at `index`. */
export function applyInsertToTokens(tokens, index, count) {
  return tokens.map((t) => {
    if (t.end <= index) return t; // opens and closes before the insert
    if (t.begin < index && index < t.end) return { ...t, end: t.end + count }; // straddles it: grows
    return { ...t, begin: t.begin + count, end: t.end + count }; // after it: shifts
  });
}

/**
 * Token extents after deleting `count` code points at `index`. Tokens that fit
 * entirely inside the deleted stretch are gone; their ids come back in
 * `deletedIds`. A zero-width token is pinned at its position: deleted only when
 * strictly inside the range, untouched when the range starts at or after it.
 */
export function applyDeleteToTokens(tokens, index, count) {
  const endIndex = index + count;
  const kept = [];
  const deletedIds = [];
  for (const t of tokens) {
    const zeroWidth = t.begin === t.end;
    const unaffected = zeroWidth ? t.end <= index : t.begin < index && t.end <= index;
    const contained = zeroWidth
      ? index < t.begin && endIndex > t.end
      : t.begin >= index && t.end <= endIndex;
    if (contained) {
      deletedIds.push(t.id);
    } else if (unaffected) {
      kept.push(t);
    } else if (t.begin >= endIndex && t.end >= endIndex) {
      kept.push({ ...t, begin: t.begin - count, end: t.end - count }); // after the range: shifts
    } else if (t.begin < index && t.end <= endIndex) {
      kept.push({ ...t, end: index }); // opens before, closes inside: clipped at the front of the range
    } else if (t.begin >= index && t.end > endIndex) {
      kept.push({ ...t, begin: index, end: t.end - count }); // opens inside, closes after: clipped at the back
    } else {
      kept.push({ ...t, end: t.end - count }); // range lies inside the token: shrinks
    }
  }
  return { tokens: kept, deletedIds };
}

/**
 * Stretch the surviving tokens of a partitioning layer back into a gapless
 * cover of a body `newLength` long: the first starts at 0, each one runs to the
 * next one's start, the last runs to the end. An empty layer stays empty (a
 * valid partition) and is left alone.
 */
export function compensatePartition(tokens, newLength) {
  if (tokens.length === 0) return tokens;
  const sorted = [...tokens].sort((a, b) => a.begin - b.begin);
  return sorted.map((t, i) => ({
    ...t,
    begin: i === 0 ? 0 : t.begin,
    end: i === sorted.length - 1 ? newLength : sorted[i + 1].begin,
  }));
}

const applyOpToBody = (body, op) => {
  if (op.type === 'insert') return cpSlice(body, 0, op.index) + op.value + cpSlice(body, op.index);
  if (op.type === 'delete') return cpSlice(body, 0, op.index) + cpSlice(body, op.index + op.value);
  throw new Error(`Unsupported local text edit: ${op.type}`);
};

/**
 * Apply `ops` (insert / delete, as sent to `texts.update`) to the raw document
 * in place: the body, every token layer of that text, every span pinned to a
 * token that went away, and every vocab link on such a token. Returns the ids
 * of the deleted tokens. `vocabs` is the `{ [vocabId]: { vocabLinks } }` table
 * the document keeps beside the raw; pass null to leave links alone.
 */
export function applyTextEditsLocally(raw, textId, ops, vocabs = null) {
  const textLayer = (raw?.textLayers || []).find((tl) => tl.text?.id === textId);
  if (!textLayer?.text) return [];
  const tokenLayers = textLayer.tokenLayers || [];
  const deletedIds = [];

  let body = textLayer.text.body ?? '';
  for (const op of ops) {
    body = applyOpToBody(body, op);
    for (const layer of tokenLayers) {
      const tokens = layer.tokens || [];
      if (op.type === 'insert') {
        layer.tokens = applyInsertToTokens(tokens, op.index, cpLength(op.value));
      } else {
        const result = applyDeleteToTokens(tokens, op.index, op.value);
        layer.tokens = result.tokens;
        deletedIds.push(...result.deletedIds);
      }
    }
  }
  textLayer.text.body = body;

  const newLength = cpLength(body);
  for (const layer of tokenLayers) {
    if (layer.overlapMode === 'partitioning') {
      layer.tokens = compensatePartition(layer.tokens || [], newLength);
    }
  }

  sweepDeadTokens(tokenLayers, deletedIds, vocabs);
  return deletedIds;
}

/**
 * Drop every span and vocab link pinned to a token in `deletedIds`, as the
 * server does when a token goes.
 */
export function sweepDeadTokens(tokenLayers, deletedIds, vocabs = null) {
  if (deletedIds.length === 0) return;
  const dead = new Set(deletedIds);
  const touchesDead = (ids) => Array.isArray(ids) && ids.some((id) => dead.has(id));
  for (const layer of tokenLayers) {
    for (const sl of layer.spanLayers || []) {
      if (Array.isArray(sl.spans)) sl.spans = sl.spans.filter((s) => !touchesDead(s.tokens));
    }
  }
  for (const vocab of Object.values(vocabs || {})) {
    if (Array.isArray(vocab?.vocabLinks)) {
      vocab.vocabLinks = vocab.vocabLinks.filter((l) => !touchesDead(l.tokens));
    }
  }
}

/**
 * Mirror a plain token delete (`tokens.delete`, no text edit): take the tokens
 * with these ids out of every token layer of the text, with the spans and
 * vocab links on them. The body and every other token stay as they are.
 */
export function removeTokensLocally(raw, textId, ids, vocabs = null) {
  const textLayer = (raw?.textLayers || []).find((tl) => tl.text?.id === textId);
  if (!textLayer?.text) return;
  const tokenLayers = textLayer.tokenLayers || [];
  const dead = new Set(ids);
  for (const layer of tokenLayers) {
    if (Array.isArray(layer.tokens)) layer.tokens = layer.tokens.filter((t) => !dead.has(t.id));
  }
  sweepDeadTokens(tokenLayers, ids, vocabs);
}
