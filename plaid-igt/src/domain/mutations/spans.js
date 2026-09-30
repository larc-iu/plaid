// Mutation mixin: span (annotation) operations. See IgtDocument.js for the
// `this` API (_queueWrite, _applyRawPatch, _settle, layerInfo, body, etc.).
//
// Convention: resolve + guard the target span layer BEFORE the patch
// (setError + return false) so a misconfigured-field edit reports failure
// rather than silently "succeeding".

import { mergeMetadata, metadataOps, createdId } from '@larc-iu/plaid-client';
import { pendingId, settledId } from '@ui/domain/pendingIds.js';
import { notSetUp } from '@ui/domain/setupGuard.js';

const findSpanLayer = (doc, scope, fieldName) => {
  const spanLayers = doc.layerInfo.spanLayers?.[scope] || [];
  return spanLayers.find((sl) => sl.name === fieldName) || null;
};

// Plan a single-token span write on a resolved layer: update if one already
// covers the target token, otherwise create. Null when there is nothing to
// write. `metadata` (optional) carries provenance for machine-produced values
// (see the shared provenance helpers), merged over any existing metadata on
// the update path; human edits pass none and get the document's stamp for
// the writer: a new span carries doc.createStamp, and an edit merges
// doc.editStamp (write-contract rule 3: a verifier's edit of a machine-made
// or contributed span verifies it, keeping provSource for history; a
// contributor's edit marks the span contributed).
const planSpan = (doc, targetLayer, targetTokenId, value, metadata) => {
  const existing = (targetLayer.spans || []).find(
    (span) => Array.isArray(span.tokens) && span.tokens.includes(targetTokenId),
  );
  // Clearing a cell DELETES the span rather than storing '' (user decision
  // 2026-08-26): an empty span is indistinguishable from "unannotated" in the
  // grid, but it would still count as an annotation everywhere else (exports,
  // queries, loss counts) and, for a machine span, would be a "verified"
  // empty value. Clearing an unannotated cell is a no-op.
  if ((value ?? '') === '') return existing ? { kind: 'delete', span: existing } : null;
  if (existing) {
    // Re-committing the value already there is a no-op (user decision
    // 2026-08-26: retyping does not confirm a machine span; the editor guards
    // this too, this keeps the rule for every caller). A caller fragment
    // (a machine writer re-stamping) still writes.
    if (!metadata && existing.value === value) return null;
    // No caller fragment = a human edit, which carries the writer's stamp.
    const fragment = metadata || doc.editStamp(existing.metadata);
    // Only the fragment's keys are sent, so a key written elsewhere since
    // this copy was loaded survives. `merged` is the same edit made locally.
    const merged = fragment ? mergeMetadata(existing.metadata, fragment) : null;
    return { kind: 'update', span: existing, value, fragment, merged };
  }
  const stamp = metadata || doc.createStamp;
  return { kind: 'create', id: pendingId(), token: targetTokenId, value, stamp };
};

const showSpan = (infoNext, scope, layerId, plan) => {
  const layerDoc = (infoNext.spanLayers?.[scope] || []).find((sl) => sl.id === layerId);
  if (!layerDoc) return;
  if (!Array.isArray(layerDoc.spans)) layerDoc.spans = [];
  if (plan.kind === 'delete') {
    layerDoc.spans = layerDoc.spans.filter((s) => s.id !== plan.span.id);
  } else if (plan.kind === 'update') {
    const s = layerDoc.spans.find((x) => x.id === plan.span.id);
    if (s) {
      s.value = plan.value;
      if (plan.merged) s.metadata = plan.merged;
    }
  } else {
    layerDoc.spans.push({
      id: plan.id,
      tokens: [plan.token],
      value: plan.value,
      ...(plan.stamp ? { metadata: plan.stamp } : {}),
    });
  }
};

// The server half of a planned span write. `ids` maps the edit's pending ids
// to the server's, and gains the new span's.
const sendSpan = async (doc, layerId, plan, ids) => {
  const serverId = (id) => ids.get(id) || settledId(id);
  if (plan.kind === 'delete') {
    await doc._client.spans.delete(serverId(plan.span.id));
  } else if (plan.kind === 'update') {
    const id = serverId(plan.span.id);
    if (plan.fragment) {
      await doc._client.batched(async (b) => {
        b.spans.update(id, plan.value);
        b.spans.patchMetadata(id, metadataOps(plan.fragment));
      });
    } else {
      await doc._client.spans.update(id, plan.value);
    }
  } else {
    const result = await doc._client.spans.create(
      layerId,
      [serverId(plan.token)],
      plan.value,
      plan.stamp || undefined,
      undefined,
      { id: plan.id },
    );
    ids.set(plan.id, createdId(result));
  }
};

// `adopted` says the value was taken from a suggestion (a guess adopted with
// Enter, a row picked from the alternatives) rather than typed, which the
// write's operation records as its kind for a reader of the audit log.
const makeSpanUpdater = (scope) =>
  async function (targetId, fieldName, value, metadata = null, { adopted = false } = {}) {
    const layer = findSpanLayer(this, scope, fieldName);
    if (!layer) {
      this.setError(notSetUp(`Annotation layer "${fieldName}" not found`));
      return false;
    }
    const label = `Failed to update ${fieldName}`;
    if (!this._canWrite(label)) return false;
    // Glossing an unanalyzed word writes its morpheme before the span that
    // hangs off it: a span needs a token to point at. Both show at once.
    const {
      ids: [id],
      creates,
    } = this._planMorphemes([targetId]);
    if (!id) {
      this.setError('Morpheme not found');
      return false;
    }
    const plan = planSpan(this, layer, id, value, metadata);
    // Nothing to write, and so no morpheme to make for it either.
    if (!plan) return true;
    this._applyRawPatch((next, infoNext) => {
      this._showMorphemes(infoNext, creates);
      showSpan(infoNext, scope, layer.id, plan);
    });
    return this._queueWrite(
      label,
      async () => {
        const ids = new Map();
        if (creates.length) {
          // The morpheme and its first span in one batch, so a refusal
          // leaves neither. A morpheme made here has no span yet, so this
          // plan is a create.
          let morphemes;
          let spanAt;
          const results = await this._client.batched(async (b) => {
            morphemes = this._queueMorphemes(b, creates);
            b.spans.create(
              layer.id,
              [morphemes.tokenRef(plan.token)],
              plan.value,
              plan.stamp || undefined,
              undefined,
              { id: plan.id },
            );
            spanAt = b.ref().$ref;
          });
          morphemes.read(results, ids);
          ids.set(plan.id, createdId(results[spanAt]));
        } else {
          await sendSpan(this, layer.id, plan, ids);
        }
        this._settle(ids);
      },
      undefined,
      adopted ? { kind: 'guess-adoption' } : {},
    );
  };

export const spanMutations = {
  updateTokenSpan: makeSpanUpdater('word'),
  updateSentenceSpan: makeSpanUpdater('sentence'),
  updateMorphemeSpan: makeSpanUpdater('morpheme'),

  // Discard a proposed sentence value (Ctrl+Backspace in a Translation
  // field): the sentence counterpart of discardWordAnalysis, for a proposal
  // that is wrong wholesale rather than worth editing. Deletes the span, so
  // the field goes back to empty and the sentence reads as unannotated.
  // No-op (true) unless the value is reviewable by this writer: the same
  // protection the word gesture gives: this only ever throws away what
  // nobody the writer defers to has vouched for.
  async discardSentenceSpan(sentenceId, fieldName) {
    const layer = findSpanLayer(this, 'sentence', fieldName);
    if (!layer) {
      this.setError(notSetUp(`Annotation layer "${fieldName}" not found`));
      return false;
    }
    const span = (layer.spans || []).find(
      (s) => Array.isArray(s.tokens) && s.tokens.includes(sentenceId),
    );
    if (!span || !this.reviewable(span.metadata)) return true;
    const label = `Failed to discard ${fieldName}`;
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.sentence || []).find((sl) => sl.id === layer.id);
      if (!layerDoc || !Array.isArray(layerDoc.spans)) return;
      layerDoc.spans = layerDoc.spans.filter((s) => s.id !== span.id);
    });
    return this._queueWrite(label, () => this._client.spans.delete(settledId(span.id)));
  },

  // Confirm a proposed sentence value as-is (Ctrl+Enter in a Translation
  // field): the span keeps its value and merges the writer's confirm stamp,
  // the sentence counterpart of confirmWordAnalysis. No-op (true) when there
  // is nothing for this writer to confirm.
  async confirmSentenceSpan(sentenceId, fieldName) {
    const layer = findSpanLayer(this, 'sentence', fieldName);
    if (!layer) {
      this.setError(notSetUp(`Annotation layer "${fieldName}" not found`));
      return false;
    }
    const span = (layer.spans || []).find(
      (s) => Array.isArray(s.tokens) && s.tokens.includes(sentenceId),
    );
    const confirm = span ? this.confirmStamp(span.metadata) : null;
    if (!confirm) return true;
    const label = `Failed to accept ${fieldName}`;
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next, infoNext) => {
      const layerDoc = (infoNext.spanLayers?.sentence || []).find((sl) => sl.id === layer.id);
      const s = layerDoc?.spans?.find((x) => x.id === span.id);
      if (s) s.metadata = mergeMetadata(s.metadata, confirm);
    });
    return this._queueWrite(
      label,
      () => this._client.spans.patchMetadata(settledId(span.id), metadataOps(confirm)),
      undefined,
      { kind: 'review' },
    );
  },
};
