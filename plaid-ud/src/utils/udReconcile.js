// Reconcile-on-open planners for UD documents.
//
// UD's rules on its own layers (a relation inside one sentence, one head per
// word, no cycle, one Form, Lemma, UPOS and XPOS per word, syntactic words as
// wide as their word) are held by the server as layer rules and applied in
// every write (udConstraints.js). What is planned here is what the rules do
// not cover: a bare word's first syntactic word, and the screen's copy of
// what a sentence split removes.

import { dependencyRelationLayers } from './udLayerUtils.js';
import { countOf } from '../../../plaid-ui/src/lib/plural.js';

// The audit label for a reconcile pass, naming what it actually changed, and
// the console's record of it. Terse on purpose: a row in a drawer. Null when
// nothing was written, which leaves the pass its plain label and, since a
// group is created lazily by its first write, usually no entry at all.
export const describeReconcile = ({ createdSyntacticWords = 0 } = {}) =>
  createdSyntacticWords
    ? `Repaired: added ${countOf(createdSyntacticWords, 'word', 'words')} to the annotation grid`
    : null;

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

/**
 * Extents of words that lack a full-width syntactic-word ("morpheme") token.
 *
 * UD annotations live on the syntactic-word layer, and the grid is built from
 * those tokens — so a word with no syntactic-word is invisible and
 * unannotatable. Another app (e.g. IGT) can create orthographic words on the
 * shared substrate without UD's syntactic-word layer, leaving words "bare".
 * This is the symmetric counterpart to IGT's "every word ≥1 morpheme" heal:
 * UD seeds one default full-width syntactic-word per bare word on open.
 *
 * Coverage is by exact extent: a syntactic-word always spans its parent word's
 * full [begin, end) (the full-width rule), and words are non-overlapping, so an
 * extent key maps a word to its syntactic-words 1:1. A word is "bare" iff no
 * syntactic-word shares its extent.
 *
 * @param {object} layerInfo the result of getUdLayerInfo (bound layers)
 * @returns {Array<{begin:number,end:number}>} extents needing a syntactic-word
 */
export const wordsNeedingSyntacticWord = (layerInfo) => {
  const wordTokens = layerInfo?.wordTokenLayer?.tokens || [];
  const morphemeTokens = layerInfo?.morphemeTokenLayer?.tokens || [];
  if (!wordTokens.length) return [];

  const covered = new Set(morphemeTokens.map((m) => `${m.begin}:${m.end}`));
  return wordTokens
    .filter((w) => !covered.has(`${w.begin}:${w.end}`))
    .map((w) => ({ begin: w.begin, end: w.end }));
};
