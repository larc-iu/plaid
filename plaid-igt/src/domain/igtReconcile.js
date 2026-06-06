// Reconcile-on-open validation for IGT documents.
//
// IGT's editor contract: every word token has at least one morpheme, and every
// morpheme is full-width over its parent word (morpheme.begin/end === word
// begin/end). When another app edits the shared substrate — e.g. UD tokenizes
// or splits a word — IGT can come back to find words with no morpheme, or
// morphemes whose extent matches no current word (orphans left by a cascade).
// The server doesn't know IGT's contract, so IGT validates on open and heals.

const extentKey = (t) => `${t.begin}:${t.end}`;

/**
 * The heal plan for a document's morpheme layer:
 *  - `wordsNeedingMorpheme`: word tokens with no full-width morpheme — create a
 *    default (empty-form) morpheme for each.
 *  - `orphanMorphemeIds`: morphemes whose extent matches no current word —
 *    delete them (heal downward; the word tokenization is authoritative).
 *
 * Returns empty lists when there is no morpheme layer (e.g. a project set up by
 * another app that IGT has not adopted yet).
 *
 * @param {object} layerInfo result of getIgtLayerInfo (bound layers)
 */
export const planMorphemeReconcile = (layerInfo) => {
  const empty = { wordsNeedingMorpheme: [], orphanMorphemeIds: [], keptAnnotatedOrphans: 0 };
  if (!layerInfo?.morphemeTokenLayer) return empty;

  const words = layerInfo.primaryTokenLayer?.tokens || [];
  const morphemes = layerInfo.morphemeTokenLayer.tokens || [];

  const morphemeExtents = new Set(morphemes.map(extentKey));
  const wordExtents = new Set(words.map(extentKey));

  // Morpheme token ids carrying at least one annotation span. We NEVER auto-delete
  // an annotated morpheme: a token delete cascades its spans, so deleting on open
  // would be silent, unrecoverable gloss loss. Annotated orphans are left in place
  // and reported for the user to reattach or remove deliberately.
  const annotated = new Set();
  (layerInfo.spanLayers?.morpheme || []).forEach(sl =>
    (sl.spans || []).forEach(sp => (sp.tokens || []).forEach(t => annotated.add(t))));

  const wordsNeedingMorpheme = words.filter(w => !morphemeExtents.has(extentKey(w)));
  const orphans = morphemes.filter(m => !wordExtents.has(extentKey(m)));
  const orphanMorphemeIds = orphans.filter(m => !annotated.has(m.id)).map(m => m.id);
  const keptAnnotatedOrphans = orphans.length - orphanMorphemeIds.length;

  return { wordsNeedingMorpheme, orphanMorphemeIds, keptAnnotatedOrphans };
};
