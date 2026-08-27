// Mutation mixin: sentence-boundary operations. See IgtDocument.js for the
// `this` API (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// The Sentences token layer is `:partitioning` — its tokens must tile
// `[0, body.length)` with no gaps and no overlaps — and it is the ROOT of the
// token nesting (words nest in sentences, morphemes in words), so deleting a
// sentence token cascades to every word and morpheme inside it. `merge` and
// `split` are partition- and nesting-preserving and are the only boundary
// edits used here; `clearSentences` is a merge of everything into the first.

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
      await this._client.tokens.merge(prev.id, sentenceId);
      this._applyRawPatch((next, infoNext) => {
        const tokens = infoNext.sentenceTokenLayer?.tokens;
        if (!Array.isArray(tokens)) return;
        const p = tokens.find((t) => t.id === prev.id);
        if (p) p.end = sentence.end;
        infoNext.sentenceTokenLayer.tokens = tokens.filter((t) => t.id !== sentenceId);
        // Server reparents the merged-away sentence's spans (translation, notes,
        // …) onto prev (token.clj merge-tokens); mirror so they don't vanish
        // until the next reload.
        reparentSpans(infoNext.spanLayers?.sentence, new Set([sentenceId]), prev.id);
      });
    });
  },

  async splitSentence(charPos) {
    const info = this.layerInfo;
    const sentenceTokens = info.sentenceTokenLayer?.tokens || [];
    const containing = sentenceTokens.find((s) => s.begin <= charPos && charPos < s.end);
    if (!containing) {
      this.setError('No sentence contains the split position');
      return false;
    }
    if (charPos === containing.begin) {
      this.setError('Cannot split at the first character of a sentence');
      return false;
    }

    return this._withSaving('Failed to split sentence', async () => {
      const originalEnd = containing.end;
      const result = await this._client.tokens.split(containing.id, charPos);
      const newRightId = result?.id || result;

      this._applyRawPatch((next, infoNext) => {
        const tokens = infoNext.sentenceTokenLayer?.tokens;
        if (!Array.isArray(tokens)) return;
        const s = tokens.find((t) => t.id === containing.id);
        if (s) s.end = charPos;
        if (newRightId) {
          tokens.push({
            id: newRightId,
            text: containing.text,
            begin: charPos,
            end: originalEnd,
          });
        }
      });
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
