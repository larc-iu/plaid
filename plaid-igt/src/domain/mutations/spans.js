// Mutation mixin: span (annotation) operations. See IgtDocument.js for the
// `this` API (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).

const upsertSpan = async (doc, scope, targetTokenId, fieldName, value) => {
  const info = doc.layerInfo;
  const spanLayers = info.spanLayers?.[scope] || [];
  const targetLayer = spanLayers.find(sl => sl.name === fieldName);
  if (!targetLayer) {
    doc.setError(`Annotation layer "${fieldName}" not found`);
    return;
  }

  const existingSpan = (targetLayer.spans || []).find(span =>
    Array.isArray(span.tokens) && span.tokens.includes(targetTokenId)
  );

  if (existingSpan) {
    await doc._client.spans.update(existingSpan.id, value);
    doc._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.[scope] || []).find(sl => sl.id === targetLayer.id);
      if (!layerDoc || !Array.isArray(layerDoc.spans)) return;
      const idx = layerDoc.spans.findIndex(s => s.id === existingSpan.id);
      if (idx !== -1) layerDoc.spans[idx].value = value;
    });
  } else {
    const result = await doc._client.spans.create(targetLayer.id, [targetTokenId], value);
    const newSpanId = result?.id || result;
    doc._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.[scope] || []).find(sl => sl.id === targetLayer.id);
      if (!layerDoc) return;
      if (!Array.isArray(layerDoc.spans)) layerDoc.spans = [];
      layerDoc.spans.push({ id: newSpanId, tokens: [targetTokenId], value });
    });
  }
};

export const spanMutations = {
  async updateTokenSpan(tokenId, fieldName, value) {
    return this._withSaving(`Failed to update ${fieldName}`, async () => {
      await upsertSpan(this, 'word', tokenId, fieldName, value);
    });
  },

  async updateSentenceSpan(sentenceId, fieldName, value) {
    return this._withSaving(`Failed to update ${fieldName}`, async () => {
      await upsertSpan(this, 'sentence', sentenceId, fieldName, value);
    });
  },

  async updateMorphemeSpan(morphemeId, fieldName, value) {
    return this._withSaving(`Failed to update ${fieldName}`, async () => {
      await upsertSpan(this, 'morpheme', morphemeId, fieldName, value);
    });
  }
};
