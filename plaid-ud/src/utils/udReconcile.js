// Reconcile-on-open validation for UD documents.
//
// UD's formalism forbids a dependency relation from crossing a sentence
// boundary. The server doesn't (and shouldn't) know this app-specific rule, so
// when another app edits the shared substrate — e.g. splits a sentence in the
// IGT editor — a UD relation that used to sit inside one sentence can end up
// straddling two. We can't catch that while UD is closed; instead UD validates
// on open and heals.
//
// This generalizes the single-split "crossing" check inside
// ConlluDocument.toggleSentenceBoundary to the whole current sentence partition.

/**
 * IDs of dependency relations whose two endpoints lie in different sentences
 * (i.e. they cross a sentence boundary). Root self-loops are ignored, and an
 * endpoint that can't be resolved to a sentence is left alone (conservative —
 * same behaviour as the edit-time check). Heal by deleting these relations:
 * heal downward toward the substrate, never move the sentence.
 *
 * @param {object} layerInfo the result of getUdLayerInfo (bound layers)
 * @returns {string[]} relation ids to delete
 */
export const interSententialRelationIds = (layerInfo) => {
  const sentenceTokens = layerInfo?.sentenceTokenLayer?.tokens || [];
  const morphemeTokens = layerInfo?.morphemeTokenLayer?.tokens || [];
  const lemmaSpans = layerInfo?.lemmaLayer?.spans || [];
  const relations = layerInfo?.relationLayer?.relations || [];
  if (!relations.length || !sentenceTokens.length) return [];

  // A begin offset falls in exactly one sentence (the sentence layer is
  // partitioning). Sort once by begin and binary-search each lookup, so the whole
  // pass is O(n log n) rather than O(spans × sentences) on the document-open path.
  const sortedSentences = [...sentenceTokens].sort((a, b) => a.begin - b.begin);
  const sentenceIdAt = (begin) => {
    if (begin == null) return null;
    let lo = 0, hi = sortedSentences.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = sortedSentences[mid];
      if (begin < s.begin) hi = mid - 1;
      else if (begin >= s.end) lo = mid + 1;
      else return s.id;
    }
    return null;
  };

  const beginByMorpheme = new Map(morphemeTokens.map(t => [t.id, t.begin]));
  const sentenceIdByLemmaSpan = new Map();
  lemmaSpans.forEach(span => {
    const tid = Array.isArray(span.tokens) && span.tokens.length > 0 ? span.tokens[0] : null;
    const begin = tid != null ? beginByMorpheme.get(tid) : null;
    sentenceIdByLemmaSpan.set(span.id, sentenceIdAt(begin));
  });

  return relations
    .filter(rel => {
      if (rel.source === rel.target) return false; // root self-loop
      const s = sentenceIdByLemmaSpan.get(rel.source);
      const t = sentenceIdByLemmaSpan.get(rel.target);
      if (s == null || t == null) return false; // unresolvable — leave it alone
      return s !== t; // different sentences -> crosses a boundary
    })
    .map(rel => rel.id);
};
