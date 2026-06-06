// Mutation mixin: sentence-boundary operations. See IgtDocument.js for the
// `this` API (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// The Sentences token layer is `:partitioning` — its tokens must tile
// `[0, body.length)` with no gaps and no overlaps. Single create/delete is
// rejected by the server, so `clearSentences` uses an atomic
// bulkDelete + bulkCreate batch. `merge` and `split` are partition-preserving
// and are the supported boundary edits.

import { cpLength } from '@larc-iu/plaid-client';

export const sentenceMutations = {
  async mergeSentence(sentenceId) {
    const info = this.layerInfo;
    const sentenceTokens = info.sentenceTokenLayer?.tokens || [];
    const sentence = sentenceTokens.find(s => s.id === sentenceId);
    if (!sentence) {
      this.setError('Sentence not found');
      return false;
    }
    const prev = sentenceTokens.find(s => s.end === sentence.begin);
    if (!prev) {
      this.setError('Cannot merge: no previous sentence');
      return false;
    }

    return this._withSaving('Failed to merge sentence', async () => {
      await this._client.tokens.merge(prev.id, sentenceId);
      this._applyRawPatch((next, infoNext) => {
        const tokens = infoNext.sentenceTokenLayer?.tokens;
        if (!Array.isArray(tokens)) return;
        const p = tokens.find(t => t.id === prev.id);
        if (p) p.end = sentence.end;
        infoNext.sentenceTokenLayer.tokens = tokens.filter(t => t.id !== sentenceId);
      });
    });
  },

  async splitSentence(charPos) {
    const info = this.layerInfo;
    const sentenceTokens = info.sentenceTokenLayer?.tokens || [];
    const containing = sentenceTokens.find(s => s.begin <= charPos && charPos < s.end);
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
        const s = tokens.find(t => t.id === containing.id);
        if (s) s.end = charPos;
        if (newRightId) {
          tokens.push({
            id: newRightId,
            text: containing.text,
            begin: charPos,
            end: originalEnd
          });
        }
      });
    });
  },

  async clearSentences() {
    const info = this.layerInfo;
    const sentenceLayer = info.sentenceTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    const sentenceTokens = sentenceLayer?.tokens || [];
    if (!sentenceLayer?.id || !textId) {
      this.setError('Sentence layer or text not configured');
      return false;
    }
    if (sentenceTokens.length === 0) return false;

    const bodyLen = cpLength(this.body);
    const sentenceIds = sentenceTokens.map(s => s.id);

    return this._withSaving('Failed to clear sentences', async () => {
      this._client.beginBatch();
      this._client.tokens.bulkDelete(sentenceIds);
      if (bodyLen > 0) {
        this._client.tokens.bulkCreate([{
          tokenLayerId: sentenceLayer.id,
          text: textId,
          begin: 0,
          end: bodyLen
        }]);
      }
      await this._client.submitBatch();
      await this._reload();
    });
  }
};
