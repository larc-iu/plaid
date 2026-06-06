// Pure layer-info helpers used by IgtDocument.
//
// `getIgtLayerInfo(raw)` returns a snapshot of the IGT layer references inside
// a raw plaid-client document. The returned references are LIVE — mutating
// e.g. `info.primaryTokenLayer.tokens.push(...)` mutates `raw`. That's the
// whole point: `_applyRawPatch` clones `raw`, derives a fresh layerInfo for
// the clone, and lets producer functions mutate through it.
//
// Span layers are bucketed by scope (Word / Morpheme / Sentence) to match
// the project setup conventions (see plaid-igt CLAUDE.md).

import {
  findBaselineTextLayer, findWordTokenLayer, findSentenceTokenLayer,
  findAlignmentTokenLayer, findMorphemeTokenLayer, readScope
} from './igtConfig.js';

export function getIgtLayerInfo(raw) {
  const textLayers = raw?.textLayers || [];
  // Substrate layers are bound by their shared role (config.plaid.role); the
  // app's private scope marker (config.igt.scope) buckets the span layers.
  const primaryTextLayer = findBaselineTextLayer(textLayers);
  const tokenLayers = primaryTextLayer?.tokenLayers || [];

  const primaryTokenLayer = findWordTokenLayer(tokenLayers);
  const sentenceTokenLayer = findSentenceTokenLayer(tokenLayers);
  const alignmentTokenLayer = findAlignmentTokenLayer(tokenLayers);
  const morphemeTokenLayer = findMorphemeTokenLayer(tokenLayers);

  const spanLayers = { word: [], morpheme: [], sentence: [] };
  (primaryTokenLayer?.spanLayers || []).forEach(sl => {
    const scope = readScope(sl.config);
    if (scope === 'Token' || scope === 'Word') spanLayers.word.push(sl);
  });
  (morphemeTokenLayer?.spanLayers || []).forEach(sl => {
    if (readScope(sl.config) === 'Morpheme') spanLayers.morpheme.push(sl);
  });
  (sentenceTokenLayer?.spanLayers || []).forEach(sl => {
    if (readScope(sl.config) === 'Sentence') spanLayers.sentence.push(sl);
  });

  return {
    primaryTextLayer,
    primaryTokenLayer,
    sentenceTokenLayer,
    alignmentTokenLayer,
    morphemeTokenLayer,
    spanLayers
  };
}

// `containsToken(outer, inner)` — character-extent containment, the canonical
// IGT parentage test (no parent-ref keys on tokens). Inclusive on both ends.
export function containsToken(outer, inner) {
  return inner.begin >= outer.begin && inner.end <= outer.end;
}
