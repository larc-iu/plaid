// Which dependency relations a sentence split takes off the screen.
//
// UD's rules on its own layers (a relation inside one sentence, one head per
// word, no cycle, one Form, Lemma, UPOS and XPOS per word, syntactic words as
// wide as their word) are held by the server as layer rules and applied in
// every write (udConstraints.js). What is planned here is the screen's copy of
// what a sentence split removes. Nothing is repaired on open (R3, 2026-10-24).

import { dependencyRelationLayers } from './udLayerUtils.js';

// The rule is about dependency relations as such, so it is asked of the
// enhanced layer's rows as well as the tree's. A suppressor lies over the same
// pair as the basic relation it suppresses and so crosses exactly when that
// one does.
const allDependencyRelations = (layerInfo) =>
  dependencyRelationLayers(layerInfo).flatMap((layer) => layer.relations || []);

/**
 * IDs of dependency relations that a new sentence boundary at `charPos` would
 * split: their two endpoints land on opposite sides of it. The edit-time case
 * of the above, where the partition being asked about is the one the split is
 * about to make rather than the one on screen, so it compares offsets against
 * charPos instead of resolving each endpoint to a sentence.
 *
 * A root self-loop is not a crossing, and an endpoint that resolves to no
 * morpheme is left alone. The server deletes these in the split's own
 * transaction (the same-ancestor rule), so the split only takes them off the
 * screen.
 *
 * @param {object} layerInfo the result of getUdLayerInfo (bound layers)
 * @param {number} charPos the offset the new boundary starts at
 * @returns {string[]} relation ids to delete
 */
export const relationsCrossing = (layerInfo, charPos) => {
  const morphemeTokens = layerInfo?.morphemeTokenLayer?.tokens || [];
  const beginByMorpheme = new Map(morphemeTokens.map((t) => [t.id, t.begin]));
  const beginByLemmaSpan = new Map();
  (layerInfo?.lemmaLayer?.spans || []).forEach((span) => {
    const tid = Array.isArray(span.tokens) && span.tokens.length > 0 ? span.tokens[0] : null;
    if (tid != null && beginByMorpheme.has(tid))
      beginByLemmaSpan.set(span.id, beginByMorpheme.get(tid));
  });
  return allDependencyRelations(layerInfo)
    .filter((rel) => {
      if (rel.source === rel.target) return false;
      const s = beginByLemmaSpan.get(rel.source);
      const t = beginByLemmaSpan.get(rel.target);
      if (s == null || t == null) return false;
      return s < charPos !== t < charPos;
    })
    .map((rel) => rel.id);
};
