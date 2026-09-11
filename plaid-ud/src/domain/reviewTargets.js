// Where the review gestures go next.
//
// The grid is virtualized: a sentence nobody has scrolled to is a placeholder,
// not cells, so a sweep that walks the DOM for its next stop would stop at the
// edge of what has been looked at. These read the document's own sentence data
// instead, which is complete whatever is on screen. The editor turns a stop
// into a scroll and a focus; nothing here knows about the DOM.
//
// A "word" here is a morpheme token, the unit the annotation grid gives a
// column to and the unit confirmTokens / discardTokens act on.

const spansOf = (entry) => [
  entry.form,
  entry.lemma,
  entry.upos,
  entry.xpos,
  ...(entry.feats || []),
];

/** Every word in the document, in reading order: `{ sentenceId, tokenId }`. */
export function wordsInOrder(sentences) {
  const out = [];
  for (const sentence of sentences || []) {
    for (const entry of sentence.tokens || []) {
      out.push({ sentenceId: sentence.id, tokenId: entry.token.id });
    }
  }
  return out;
}

/**
 * The words still holding material this writer reviews, in reading order.
 * `reviewable` is the writer policy's predicate: a verifier reviews machine
 * and contributed material, a contributor machine proposals only.
 *
 * A word counts when any of its spans does, or when its INCOMING dependency
 * relation does: the two things confirmTokens covers, so a stop is never a
 * word whose ✓ would do nothing.
 */
export function reviewWords(sentences, reviewable) {
  const out = [];
  for (const sentence of sentences || []) {
    // The dependent of a relation is its TARGET lemma span, so map lemma span
    // back to the word it annotates.
    const tokenByLemma = new Map();
    for (const entry of sentence.tokens || []) {
      if (entry.lemma?.id) tokenByLemma.set(entry.lemma.id, entry.token.id);
    }
    const byRelation = new Set();
    for (const relation of sentence.relations || []) {
      if (!reviewable(relation.metadata)) continue;
      const tokenId = tokenByLemma.get(relation.target);
      if (tokenId) byRelation.add(tokenId);
    }
    for (const entry of sentence.tokens || []) {
      const tokenId = entry.token.id;
      const marked =
        byRelation.has(tokenId) || spansOf(entry).some((s) => s && reviewable(s.metadata));
      if (marked) out.push({ sentenceId: sentence.id, tokenId });
    }
  }
  return out;
}

/**
 * The word after (or before) `tokenId` in reading order, crossing sentence
 * boundaries, or null at the ends. What Ctrl/Cmd+Enter hops to once it has
 * accepted a word.
 */
export function adjacentWord(sentences, tokenId, dir = 'next') {
  const order = wordsInOrder(sentences);
  const i = order.findIndex((w) => w.tokenId === tokenId);
  if (i === -1) return null;
  return order[dir === 'next' ? i + 1 : i - 1] || null;
}

/**
 * The next (or previous) word needing a look, relative to wherever the caret
 * is. Sentence boundaries are crossed. A caret in a word with nothing to review
 * still finds the next word that has something; a caret nowhere in the grid
 * starts from the appropriate end. Null when there is nothing left.
 */
export function nextReviewWord(sentences, reviewable, tokenId, dir = 'next') {
  const stops = reviewWords(sentences, reviewable);
  if (!stops.length) return null;
  const order = wordsInOrder(sentences);
  const positionOf = new Map(order.map((w, i) => [w.tokenId, i]));
  const from = tokenId != null && positionOf.has(tokenId) ? positionOf.get(tokenId) : null;
  if (from == null) return dir === 'next' ? stops[0] : stops[stops.length - 1];
  return dir === 'next'
    ? (stops.find((s) => positionOf.get(s.tokenId) > from) ?? null)
    : ([...stops].reverse().find((s) => positionOf.get(s.tokenId) < from) ?? null);
}

/**
 * Which of a word's annotation fields still hold material this writer reviews,
 * in grid order. What the sweep lands the caret on, so a stop opens on the cell
 * that earned it rather than on whichever row the caret happened to be in.
 * `feats` counts when ANY of the word's feature spans does.
 */
export const REVIEW_FIELDS = Object.freeze(['lemma', 'xpos', 'upos', 'feats']);

export function markedFields(entry, reviewable) {
  if (!entry) return [];
  const marked = (span) => !!span && reviewable(span.metadata);
  return REVIEW_FIELDS.filter((field) =>
    field === 'feats' ? (entry.feats || []).some(marked) : marked(entry[field]),
  );
}

/** The sentence entry for a word, or null. */
export function findWord(sentences, tokenId) {
  for (const sentence of sentences || []) {
    for (const entry of sentence.tokens || []) {
      if (entry.token.id === tokenId) return entry;
    }
  }
  return null;
}

/**
 * Whether a word holds any material matching `predicate`: its spans OR its
 * incoming dependency relation. This is the "is there anything for this gesture
 * to do" test, and it has to include the relation: a word whose only machine
 * material is the head the parser guessed is exactly the case markedFields
 * cannot see, since the relation is not one of the word's cells.
 *
 * Pass the writer policy's `reviewable` for the accept gesture and `isMachine`
 * for discard, which takes machine material only.
 */
export function wordHasMaterial(sentences, tokenId, predicate) {
  for (const sentence of sentences || []) {
    const entry = (sentence.tokens || []).find((t) => t.token.id === tokenId);
    if (!entry) continue;
    if (spansOf(entry).some((s) => s && predicate(s.metadata))) return true;
    const lemmaId = entry.lemma?.id;
    if (!lemmaId) return false;
    return (sentence.relations || []).some((r) => r.target === lemmaId && predicate(r.metadata));
  }
  return false;
}
