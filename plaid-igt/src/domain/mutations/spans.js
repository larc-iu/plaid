// Mutation mixin: span (annotation) operations. See IgtDocument.js for the
// `this` API (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// Convention: resolve + guard the target span layer OUTSIDE `_withSaving`
// (setError + return false) so a misconfigured-field edit reports failure
// rather than silently "succeeding" via the saving wrapper.

import { mergeMetadata } from '@larc-iu/plaid-client';
import { isVirtualMorphemeId } from '../virtualMorpheme.js';

const findSpanLayer = (doc, scope, fieldName) => {
  const spanLayers = doc.layerInfo.spanLayers?.[scope] || [];
  return spanLayers.find((sl) => sl.name === fieldName) || null;
};

// Upsert a single-token span on a resolved layer: update if one already covers
// the target token, otherwise create. Applies the optimistic patch in both
// branches. `metadata` (optional) carries provenance for machine-produced
// values (see the shared provenance helpers) — merged over any existing
// metadata on the update path; human edits pass none and get the document's
// stamp for the writer: a new span carries doc.createStamp, and an edit
// merges doc.editStamp (write-contract rule 3: a verifier's edit of a
// machine-made or contributed span verifies it, keeping provSource for
// history; a contributor's edit marks the span contributed).
const upsertSpan = async (doc, scope, targetLayer, targetTokenId, value, metadata) => {
  const existingSpan = (targetLayer.spans || []).find(
    (span) => Array.isArray(span.tokens) && span.tokens.includes(targetTokenId),
  );

  // Clearing a cell DELETES the span rather than storing '' (user decision
  // 2026-08-26): an empty span is indistinguishable from "unannotated" in the
  // grid, but it would still count as an annotation everywhere else (exports,
  // queries, loss counts) and — for a machine span — would be a "verified"
  // empty value. Clearing an unannotated cell is a no-op.
  if ((value ?? '') === '') {
    if (!existingSpan) return;
    await doc._client.spans.delete(existingSpan.id);
    doc._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.[scope] || []).find((sl) => sl.id === targetLayer.id);
      if (!layerDoc || !Array.isArray(layerDoc.spans)) return;
      layerDoc.spans = layerDoc.spans.filter((s) => s.id !== existingSpan.id);
    });
    return;
  }

  if (existingSpan) {
    // Re-committing the value already there is a no-op (user decision
    // 2026-08-26: retyping does not confirm a machine span; the editor guards
    // this too, this keeps the rule for every caller). A caller fragment
    // (a machine writer re-stamping) still writes.
    if (!metadata && existingSpan.value === value) return;
    // No caller fragment = a human edit, which carries the writer's stamp.
    const fragment = metadata || doc.editStamp(existingSpan.metadata);
    const mergedMetadata = fragment ? mergeMetadata(existingSpan.metadata, fragment) : null;
    if (mergedMetadata) {
      await doc._client.batched(async () => {
        doc._client.spans.update(existingSpan.id, value);
        doc._client.spans.setMetadata(existingSpan.id, mergedMetadata);
      });
    } else {
      await doc._client.spans.update(existingSpan.id, value);
    }
    doc._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.[scope] || []).find((sl) => sl.id === targetLayer.id);
      if (!layerDoc || !Array.isArray(layerDoc.spans)) return;
      const idx = layerDoc.spans.findIndex((s) => s.id === existingSpan.id);
      if (idx !== -1) {
        layerDoc.spans[idx].value = value;
        if (mergedMetadata) layerDoc.spans[idx].metadata = mergedMetadata;
      }
    });
  } else {
    const stamp = metadata || doc.createStamp;
    const result = await doc._client.spans.create(
      targetLayer.id,
      [targetTokenId],
      value,
      stamp || undefined,
    );
    const newSpanId = result?.id || result;
    doc._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.[scope] || []).find((sl) => sl.id === targetLayer.id);
      if (!layerDoc) return;
      if (!Array.isArray(layerDoc.spans)) layerDoc.spans = [];
      layerDoc.spans.push({
        id: newSpanId,
        tokens: [targetTokenId],
        value,
        ...(stamp ? { metadata: stamp } : {}),
      });
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
      // Glossing an unanalyzed word writes its morpheme before the span that
      // hangs off it: a span needs a token to point at. Any other id is handed
      // straight back (see materializeMorphemeId).
      const id = isVirtualMorphemeId(targetId)
        ? await this.materializeMorphemeId(targetId)
        : targetId;
      if (!id) throw new Error(`Morpheme ${targetId} not found`);
      await upsertSpan(this, scope, layer, id, value, metadata);
    });
  };

export const spanMutations = {
  updateTokenSpan: makeSpanUpdater('word'),
  updateSentenceSpan: makeSpanUpdater('sentence'),
  updateMorphemeSpan: makeSpanUpdater('morpheme'),

  // Discard a proposed sentence value (Ctrl+Backspace in a Translation
  // field): the sentence counterpart of discardWordAnalysis, for a proposal
  // that is wrong wholesale rather than worth editing. Deletes the span, so
  // the field goes back to empty and the sentence reads as unannotated.
  // No-op (true) unless the value is reviewable by this writer — the same
  // protection the word gesture gives: this only ever throws away what
  // nobody the writer defers to has vouched for.
  async discardSentenceSpan(sentenceId, fieldName) {
    const layer = findSpanLayer(this, 'sentence', fieldName);
    if (!layer) {
      this.setError(`Annotation layer "${fieldName}" not found`);
      return false;
    }
    const span = (layer.spans || []).find(
      (s) => Array.isArray(s.tokens) && s.tokens.includes(sentenceId),
    );
    if (!span || !this.reviewable(span.metadata)) return true;
    return this._withSaving(`Failed to discard ${fieldName}`, async () => {
      await this._client.spans.delete(span.id);
      this._applyRawPatch((next, infoNext) => {
        const layerDoc = (infoNext.spanLayers?.sentence || []).find((sl) => sl.id === layer.id);
        if (!layerDoc || !Array.isArray(layerDoc.spans)) return;
        layerDoc.spans = layerDoc.spans.filter((s) => s.id !== span.id);
      });
    });
  },

  // Confirm a proposed sentence value as-is (Ctrl+Enter in a Translation
  // field): the span keeps its value and merges the writer's confirm stamp,
  // the sentence counterpart of confirmWordAnalysis. No-op (true) when there
  // is nothing for this writer to confirm.
  async confirmSentenceSpan(sentenceId, fieldName) {
    const layer = findSpanLayer(this, 'sentence', fieldName);
    if (!layer) {
      this.setError(`Annotation layer "${fieldName}" not found`);
      return false;
    }
    const span = (layer.spans || []).find(
      (s) => Array.isArray(s.tokens) && s.tokens.includes(sentenceId),
    );
    const confirm = span ? this.confirmStamp(span.metadata) : null;
    if (!confirm) return true;
    return this._withSaving(`Failed to confirm ${fieldName}`, async () => {
      await this._client.spans.patchMetadata(span.id, confirm);
      this._applyRawPatch((next, infoNext) => {
        const layerDoc = (infoNext.spanLayers?.sentence || []).find((sl) => sl.id === layer.id);
        const idx = layerDoc?.spans?.findIndex((s) => s.id === span.id) ?? -1;
        if (idx !== -1) {
          layerDoc.spans[idx].metadata = mergeMetadata(layerDoc.spans[idx].metadata, confirm);
        }
      });
    });
  },
};
