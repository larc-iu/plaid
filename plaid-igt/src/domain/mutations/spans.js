// Mutation mixin: span (annotation) operations. See IgtDocument.js for the
// `this` API (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// Convention: resolve + guard the target span layer OUTSIDE `_withSaving`
// (setError + return false) so a misconfigured-field edit reports failure
// rather than silently "succeeding" via the saving wrapper.

const findSpanLayer = (doc, scope, fieldName) => {
  const spanLayers = doc.layerInfo.spanLayers?.[scope] || [];
  return spanLayers.find(sl => sl.name === fieldName) || null;
};

// Upsert a single-token span on a resolved layer: update if one already covers
// the target token, otherwise create. Applies the optimistic patch in both
// branches. `metadata` (optional) carries provenance for machine-produced
// values (see domain/glossGuess.js PROV) — merged over any existing metadata
// on the update path; human edits pass none.
const upsertSpan = async (doc, scope, targetLayer, targetTokenId, value, metadata) => {
  const existingSpan = (targetLayer.spans || []).find(span =>
    Array.isArray(span.tokens) && span.tokens.includes(targetTokenId)
  );

  if (existingSpan) {
    const mergedMetadata = metadata ? { ...(existingSpan.metadata || {}), ...metadata } : null;
    if (mergedMetadata) {
      doc._client.beginBatch();
      doc._client.spans.update(existingSpan.id, value);
      doc._client.spans.setMetadata(existingSpan.id, mergedMetadata);
      await doc._client.submitBatch();
    } else {
      await doc._client.spans.update(existingSpan.id, value);
    }
    doc._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.[scope] || []).find(sl => sl.id === targetLayer.id);
      if (!layerDoc || !Array.isArray(layerDoc.spans)) return;
      const idx = layerDoc.spans.findIndex(s => s.id === existingSpan.id);
      if (idx !== -1) {
        layerDoc.spans[idx].value = value;
        if (mergedMetadata) layerDoc.spans[idx].metadata = mergedMetadata;
      }
    });
  } else {
    const result = await doc._client.spans.create(targetLayer.id, [targetTokenId], value, metadata || undefined);
    const newSpanId = result?.id || result;
    doc._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.[scope] || []).find(sl => sl.id === targetLayer.id);
      if (!layerDoc) return;
      if (!Array.isArray(layerDoc.spans)) layerDoc.spans = [];
      layerDoc.spans.push({ id: newSpanId, tokens: [targetTokenId], value, ...(metadata ? { metadata } : {}) });
    });
  }
};

const makeSpanUpdater = (scope) =>
  async function (targetId, fieldName, value, metadata = null) {
    const layer = findSpanLayer(this, scope, fieldName);
    if (!layer) {
      this.setError(`Annotation layer "${fieldName}" not found`);
      return false;
    }
    return this._withSaving(`Failed to update ${fieldName}`, async () => {
      await upsertSpan(this, scope, layer, targetId, value, metadata);
    });
  };

export const spanMutations = {
  updateTokenSpan: makeSpanUpdater('word'),
  updateSentenceSpan: makeSpanUpdater('sentence'),
  updateMorphemeSpan: makeSpanUpdater('morpheme'),
};
