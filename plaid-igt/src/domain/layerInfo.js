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

export function getIgtLayerInfo(raw) {
  const textLayers = raw?.textLayers || [];
  const primaryTextLayer = textLayers.find(l => l.config?.plaid?.primary) || null;
  const tokenLayers = primaryTextLayer?.tokenLayers || [];

  const primaryTokenLayer = tokenLayers.find(l => l.config?.plaid?.primary) || null;
  const sentenceTokenLayer = tokenLayers.find(l => l.config?.plaid?.sentence) || null;
  const alignmentTokenLayer = tokenLayers.find(l => l.config?.plaid?.alignment) || null;
  const morphemeTokenLayer = tokenLayers.find(l => l.config?.plaid?.morpheme) || null;

  const spanLayers = { word: [], morpheme: [], sentence: [] };
  (primaryTokenLayer?.spanLayers || []).forEach(sl => {
    const scope = sl.config?.plaid?.scope;
    if (scope === 'Token' || scope === 'Word') spanLayers.word.push(sl);
  });
  (morphemeTokenLayer?.spanLayers || []).forEach(sl => {
    if (sl.config?.plaid?.scope === 'Morpheme') spanLayers.morpheme.push(sl);
  });
  (sentenceTokenLayer?.spanLayers || []).forEach(sl => {
    if (sl.config?.plaid?.scope === 'Sentence') spanLayers.sentence.push(sl);
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
