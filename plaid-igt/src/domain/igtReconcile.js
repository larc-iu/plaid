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

/**
 * Heal plan for duplicate sentence-level spans. IGT's contract: at most ONE
 * span per sentence-scope layer per sentence token. A sentence merge in
 * another app (the server's tokens.merge reparents the dying token's spans to
 * the survivor) leaves duplicates — which this editor neither shows nor can
 * edit (the derive step renders the FIRST span per layer; the rest are
 * invisible and immortal). Heal LOSSLESSLY: concatenate the distinct values
 * into the first span (' | ') and delete the rest, so everything is visible
 * for a human to revise. Reported loudly by the caller.
 *
 * Returns [{layerId, layerName, tokenId, keepSpanId, mergedValue, needsUpdate,
 * deleteSpanIds}] — one entry per (layer, sentence token) with >1 span.
 */
export const planSentenceSpanDedup = (layerInfo) => {
  const plans = [];
  for (const sl of layerInfo?.spanLayers?.sentence || []) {
    const byToken = new Map();
    for (const sp of sl.spans || []) {
      // IGT sentence spans are single-token by construction; leave anything
      // exotic (multi-token spans) alone.
      if (!Array.isArray(sp.tokens) || sp.tokens.length !== 1) continue;
      const tid = sp.tokens[0];
      if (!byToken.has(tid)) byToken.set(tid, []);
      byToken.get(tid).push(sp);
    }
    byToken.forEach((spans, tokenId) => {
      if (spans.length < 2) return;
      const values = [];
      for (const sp of spans) {
        const v = sp.value == null ? '' : String(sp.value);
        if (v !== '' && !values.includes(v)) values.push(v);
      }
      const mergedValue = values.join(' | ');
      const firstValue = spans[0].value == null ? '' : String(spans[0].value);
      plans.push({
        layerId: sl.id,
        layerName: sl.name,
        tokenId,
        keepSpanId: spans[0].id,
        mergedValue,
        needsUpdate: mergedValue !== firstValue,
        deleteSpanIds: spans.slice(1).map(s => s.id),
      });
    });
  }
  return plans;
};
