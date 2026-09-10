// Mutation mixin: sentence-boundary operations. See IgtDocument.js for the
// `this` API (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// The Sentences token layer is `:partitioning` — its tokens must tile
// `[0, body.length)` with no gaps and no overlaps — and it is the ROOT of the
// token nesting (words nest in sentences, morphemes in words), so deleting a
// sentence token cascades to every word and morpheme inside it. `merge` and
// `split` are partition- and nesting-preserving and are the only boundary
// edits used here; `clearSentences` is a merge of everything into the first.

import { mergeMetadata } from '@larc-iu/plaid-client';
import { newHalfMetadata, survivingProvenance, survivorPatch } from '../tokenReshape.js';
import { reparentSpans } from './reparent.js';

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

    return this._withSaving('Failed to merge sentence', async () => {
      // See domain/tokenReshape.js: the survivor takes on the provenance of
      // whichever side most needs review, so a machine-made sentence boundary
      // is not absorbed into a hand-made neighbour.
      const inherited = survivingProvenance([prev.metadata, sentence.metadata]);
      const patch = survivorPatch(prev.metadata, inherited, (m) => this.editStamp(m));
      await this._client.batched(async () => {
        this._client.tokens.merge(prev.id, sentenceId);
        if (patch) this._client.tokens.patchMetadata(prev.id, patch);
      });
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
        // …) onto prev (token.clj merge-tokens); mirror so they don't vanish
        // until the next reload.
        reparentSpans(infoNext.spanLayers?.sentence, new Set([sentenceId]), prev.id);
      });
    });
  },

  async splitSentence(charPos) {
    const containing = this._sentenceToSplitAt(charPos);
    if (!containing) return false;
    return this._withSaving('Failed to split sentence', () =>
      this._splitSentenceOnce(containing, charPos),
    );
  },

  // Split sentences at several positions in ONE operation, each split seen
  // by the next: a later position inside a sentence an earlier one already
  // split lands in the new right half, which the local patch has by then.
  // Positions are taken in order and a position that no longer splits
  // anything (a sentence already begins there) is passed over.
  async splitSentencesAt(positions) {
    const sorted = [...new Set(positions)].sort((a, b) => a - b);
    if (!sorted.length) return false;
    return this._withSaving('Failed to split sentences', async () => {
      for (const charPos of sorted) {
        const containing = this._sentenceToSplitAt(charPos, { quiet: true });
        if (containing) await this._splitSentenceOnce(containing, charPos);
      }
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
    return containing;
  },

  async _splitSentenceOnce(containing, charPos) {
    const originalEnd = containing.end;
    const result = await this._client.tokens.split(containing.id, charPos);
    const newRightId = result?.id || result;

    // Both halves of a split carry the same mark: see domain/tokenReshape.js.
    const leftPatch = survivorPatch(containing.metadata, {}, (m) => this.editStamp(m));
    const rightMetadata = newHalfMetadata(containing.metadata, (m) => this.editStamp(m));
    if (leftPatch || (newRightId && rightMetadata)) {
      await this._client.batched(async () => {
        if (leftPatch) this._client.tokens.patchMetadata(containing.id, leftPatch);
        if (newRightId && rightMetadata)
          this._client.tokens.patchMetadata(newRightId, rightMetadata);
      });
    }

    this._applyRawPatch((next, infoNext) => {
      const tokens = infoNext.sentenceTokenLayer?.tokens;
      if (!Array.isArray(tokens)) return;
      const s = tokens.find((t) => t.id === containing.id);
      if (s) s.end = charPos;
      if (newRightId) {
        tokens.push({
          id: newRightId,
          begin: charPos,
          end: originalEnd,
        });
      }
    });
  },

  // Reset to a single sentence spanning the whole text. Sentence tokens are
  // merged into the first one (a bulkDelete + bulkCreate would cascade-delete
  // every nested word and morpheme). Sentence-scope spans (translations, …)
  // are deleted, as the confirm dialog promises — a merge would otherwise
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

    const first = sentenceTokens[0];
    const sentenceIds = new Set(sentenceTokens.map((s) => s.id));
    const spanIds = (info.spanLayers?.sentence || []).flatMap((sl) =>
      (sl.spans || [])
        .filter((sp) => (sp.tokens || []).some((t) => sentenceIds.has(t)))
        .map((sp) => sp.id),
    );

    return this._withSaving('Failed to clear sentences', async () => {
      await this._client.batched(async () => {
        spanIds.forEach((id) => this._client.spans.delete(id));
        // Sequential merges into the first sentence in begin-order; the server
        // processes batch ops in order, so each merge sees the widened extent.
        for (let i = 1; i < sentenceTokens.length; i++) {
          this._client.tokens.merge(first.id, sentenceTokens[i].id);
        }
      });
      await this._reload();
    });
  },
};
