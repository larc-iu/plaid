// Mutation mixin: sentence-boundary operations. See IgtDocument.js for the
// `this` API (_queueWrite, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// The Sentences token layer is `:partitioning` — its tokens must tile
// `[0, body.length)` with no gaps and no overlaps — and it is the ROOT of the
// token nesting (words nest in sentences, morphemes in words), so deleting a
// sentence token cascades to every word and morpheme inside it. `merge` and
// `split` are partition- and nesting-preserving and are the only boundary
// edits used here; `clearSentences` is a merge of everything into the first.

import { mergeMetadata, metadataOps, createdId } from '@larc-iu/plaid-client';
import { newHalfMetadata, survivingProvenance, survivorPatch } from '../tokenReshape.js';
import { reparentSpans } from './reparent.js';
import { pendingId, settledId } from '@ui/domain/pendingIds.js';

export const sentenceMutations = {
  async mergeSentence(sentenceId) {
    const info = this.layerInfo;
    const sentenceTokens = info.sentenceTokenLayer?.tokens || [];
    const sentence = sentenceTokens.find((s) => s.id === sentenceId);
    if (!sentence) {
      this.setError('Sentence not found');
      return false;
    }
    const prev = sentenceTokens.find((s) => s.end === sentence.begin);
    if (!prev) {
      this.setError('Cannot merge: no previous sentence');
      return false;
    }
    const label = 'Failed to merge sentence';
    if (!this._canWrite(label)) return false;
    // See domain/tokenReshape.js: the survivor takes on the provenance of
    // whichever side most needs review, so a machine-made sentence boundary
    // is not absorbed into a hand-made neighbour.
    const inherited = survivingProvenance([prev.metadata, sentence.metadata]);
    const patch = survivorPatch(prev.metadata, inherited, (m) => this.editStamp(m));
    this._applyRawPatch((next, infoNext) => {
      const tokens = infoNext.sentenceTokenLayer?.tokens;
      if (!Array.isArray(tokens)) return;
      const p = tokens.find((t) => t.id === prev.id);
      if (p) {
        p.end = sentence.end;
        if (patch) p.metadata = mergeMetadata(p.metadata || {}, patch);
      }
      infoNext.sentenceTokenLayer.tokens = tokens.filter((t) => t.id !== sentenceId);
      // Server reparents the merged-away sentence's spans (translation, notes,
      // …) onto prev (token.clj merge-tokens); mirrored here.
      reparentSpans(infoNext.spanLayers?.sentence, new Set([sentenceId]), prev.id);
    });
    return this._queueWrite(label, () =>
      this._client.batched(async (b) => {
        b.tokens.merge(settledId(prev.id), settledId(sentenceId));
        if (patch) b.tokens.patchMetadata(settledId(prev.id), metadataOps(patch));
      }),
    );
  },

  async splitSentence(charPos) {
    return this.splitSentencesAt([charPos], { quiet: false });
  },

  // Split sentences at several positions in ONE operation, each split seen
  // by the next: a later position inside a sentence an earlier one already
  // split lands in the new right half, which the local patch has by then.
  // Positions are taken in order and a position that no longer splits
  // anything (a sentence already begins there, or it falls inside a word) is
  // passed over, or refused when the caller is not quiet. Every new
  // sentence shows at once.
  async splitSentencesAt(positions, { quiet = true } = {}) {
    const sorted = [...new Set(positions)].sort((a, b) => a - b);
    if (!sorted.length) return false;
    const label =
      sorted.length === 1 && !quiet ? 'Failed to split sentence' : 'Failed to split sentences';
    if (!this._canWrite(label)) return false;
    const splits = [];
    for (const charPos of sorted) {
      const containing = this._sentenceToSplitAt(charPos, { quiet });
      if (!containing) continue;
      splits.push(this._showSentenceSplit(containing, charPos));
    }
    if (!splits.length) return false;
    return this._queueWrite(label, async () => {
      const ids = new Map();
      const serverId = (id) => ids.get(id) || settledId(id);
      // One request a split: each needs the id the one before it made.
      for (const s of splits) {
        const result = await this._client.tokens.split(serverId(s.leftId), s.charPos);
        ids.set(s.rightId, createdId(result));
      }
      const patches = splits.flatMap((s) => [
        ...(s.leftPatch ? [[serverId(s.leftId), s.leftPatch]] : []),
        ...(s.rightMetadata && ids.get(s.rightId) ? [[ids.get(s.rightId), s.rightMetadata]] : []),
      ]);
      if (patches.length) {
        await this._client.batched(async (b) => {
          patches.forEach(([id, p]) => b.tokens.patchMetadata(id, metadataOps(p)));
        });
      }
      this._settle(ids);
    });
  },

  _sentenceToSplitAt(charPos, { quiet = false } = {}) {
    const sentenceTokens = this.layerInfo.sentenceTokenLayer?.tokens || [];
    const containing = sentenceTokens.find((s) => s.begin <= charPos && charPos < s.end);
    if (!containing) {
      if (!quiet) this.setError('No sentence contains the split position');
      return null;
    }
    if (charPos === containing.begin) {
      if (!quiet) this.setError('Cannot split at the first character of a sentence');
      return null;
    }
    // A word belongs to one sentence. A cut through it would split its
    // morphemes and leave both halves with no form or gloss.
    const words = this.layerInfo.primaryTokenLayer?.tokens || [];
    if (words.some((w) => w.begin < charPos && charPos < w.end)) {
      if (!quiet) this.setError('Cannot split a sentence inside a word');
      return null;
    }
    return containing;
  },

  // One split, shown: the left half keeps the sentence's identity and the
  // right half is new, under a pending id. Answers what the send needs.
  _showSentenceSplit(containing, charPos) {
    // Both halves of a split carry the same mark: see domain/tokenReshape.js.
    const leftPatch = survivorPatch(containing.metadata, {}, (m) => this.editStamp(m));
    const rightMetadata = newHalfMetadata(containing.metadata, (m) => this.editStamp(m));
    const rightId = pendingId();
    this._applyRawPatch((next, infoNext) => {
      const tokens = infoNext.sentenceTokenLayer?.tokens;
      if (!Array.isArray(tokens)) return;
      const s = tokens.find((t) => t.id === containing.id);
      if (s) {
        s.end = charPos;
        if (leftPatch) s.metadata = mergeMetadata(s.metadata || {}, leftPatch);
      }
      tokens.push({
        id: rightId,
        begin: charPos,
        end: containing.end,
        ...(rightMetadata ? { metadata: rightMetadata } : {}),
      });
      tokens.sort((a, b) => a.begin - b.begin);
    });
    return { leftId: containing.id, rightId, charPos, leftPatch, rightMetadata };
  },

  // Reset to a single sentence spanning the whole text. Sentence tokens are
  // merged into the first one (a bulkDelete + bulkCreate would cascade-delete
  // every nested word and morpheme). Sentence-scope spans (translations, …)
  // are deleted, as the confirm dialog promises: a merge would otherwise
  // reparent them all onto the survivor.
  async clearSentences() {
    const info = this.layerInfo;
    const sentenceLayer = info.sentenceTokenLayer;
    const sentenceTokens = [...(sentenceLayer?.tokens || [])].sort((a, b) => a.begin - b.begin);
    if (!sentenceLayer?.id) {
      this.setError('Sentence layer not configured');
      return false;
    }
    if (sentenceTokens.length === 0) return false;
    const label = 'Failed to clear sentences';
    if (!this._canWrite(label)) return false;

    const first = sentenceTokens[0];
    const last = sentenceTokens[sentenceTokens.length - 1];
    const sentenceIds = new Set(sentenceTokens.map((s) => s.id));
    const spanIds = (info.spanLayers?.sentence || []).flatMap((sl) =>
      (sl.spans || [])
        .filter((sp) => (sp.tokens || []).some((t) => sentenceIds.has(t)))
        .map((sp) => sp.id),
    );
    const gone = new Set(spanIds);
    this._applyRawPatch((next, infoNext) => {
      const layer = infoNext.sentenceTokenLayer;
      const keep = (layer.tokens || []).find((t) => t.id === first.id);
      if (keep) keep.end = last.end;
      layer.tokens = keep ? [keep] : [];
      (infoNext.spanLayers?.sentence || []).forEach((sl) => {
        if (Array.isArray(sl.spans)) sl.spans = sl.spans.filter((sp) => !gone.has(sp.id));
      });
    });
    return this._queueWrite(label, () =>
      this._client.batched(async (b) => {
        spanIds.forEach((id) => b.spans.delete(settledId(id)));
        // Sequential merges into the first sentence in begin-order; the server
        // processes batch ops in order, so each merge sees the widened extent.
        for (let i = 1; i < sentenceTokens.length; i++) {
          b.tokens.merge(settledId(first.id), settledId(sentenceTokens[i].id));
        }
      }),
    );
  },
};
