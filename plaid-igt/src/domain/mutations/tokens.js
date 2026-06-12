// Mutation mixin: word-token operations. See IgtDocument.js for the `this`
// API (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.) and the
// splitToken template method.

import {
  tokenizeText,
  findUntokenizedRanges,
  getIgnoredTokensConfig,
  validateTokenization
} from '../../utils/tokenizationUtils.js';
import { reparentSpans, reparentVocabLinks } from './reparent.js';

const findCoincidentMorphemeIds = (morphemeTokens, targets) => {
  if (!Array.isArray(morphemeTokens) || morphemeTokens.length === 0) return [];
  const ranges = new Set(targets.map(t => `${t.begin}-${t.end}`));
  const ids = [];
  morphemeTokens.forEach(m => {
    if (ranges.has(`${m.begin}-${m.end}`)) ids.push(m.id);
  });
  return ids;
};

export const tokenMutations = {
  // Merge a set of word tokens into the earliest-beginning one, which grows
  // to cover the rest. Coincident morphemes (same begin/end as any merged
  // word token) are deleted in the same atomic batch — their analysis is
  // invalidated by the new boundary, same rationale as splitToken.
  async mergeTokens(tokenIds) {
    const ids = tokenIds instanceof Set ? Array.from(tokenIds) : Array.from(tokenIds || []);
    if (ids.length <= 1) return false;

    return this._withSaving('Failed to merge tokens', async () => {
      const info = this.layerInfo;
      const wordTokens = info.primaryTokenLayer?.tokens || [];
      const idSet = new Set(ids);
      const toMerge = wordTokens
        .filter(t => idSet.has(t.id))
        .sort((a, b) => a.begin - b.begin);
      if (toMerge.length <= 1) throw new Error('Not enough tokens to merge');

      const firstToken = toMerge[0];
      const lastToken = toMerge[toMerge.length - 1];
      const coincident = findCoincidentMorphemeIds(info.morphemeTokenLayer?.tokens || [], toMerge);

      this._client.beginBatch();
      if (coincident.length > 0) this._client.tokens.bulkDelete(coincident);
      // Sequential merges into firstToken in begin-order. The server processes
      // batch ops sequentially, so each merge sees firstToken's widened extent.
      for (let i = 1; i < toMerge.length; i++) {
        this._client.tokens.merge(firstToken.id, toMerge[i].id);
      }
      await this._client.submitBatch();

      const removedWordIds = new Set(toMerge.slice(1).map(t => t.id));
      const removedMorphIds = new Set(coincident);

      this._applyRawPatch((next, infoNext, vocabs) => {
        if (infoNext.primaryTokenLayer?.tokens) {
          const first = infoNext.primaryTokenLayer.tokens.find(t => t.id === firstToken.id);
          if (first) first.end = lastToken.end;
          infoNext.primaryTokenLayer.tokens = infoNext.primaryTokenLayer.tokens.filter(t => !removedWordIds.has(t.id));
        }
        if (removedMorphIds.size > 0 && infoNext.morphemeTokenLayer?.tokens) {
          infoNext.morphemeTokenLayer.tokens = infoNext.morphemeTokenLayer.tokens.filter(m => !removedMorphIds.has(m.id));
        }
        // Server reparents word-scope spans + vocab links from the merged-away
        // words onto firstToken (token.clj merge-tokens); mirror that so they
        // don't vanish until the next reload. Morpheme-scope spans/links on the
        // deleted coincident morphemes are cascade-DELETED server-side, so they
        // are correctly left to drop out (orphaned, never rendered).
        reparentSpans(infoNext.spanLayers?.word, removedWordIds, firstToken.id);
        reparentVocabLinks(vocabs, removedWordIds, firstToken.id);
      });
    });
  },

  // Delete a single word token. The server cascades the morpheme deletion
  // (morpheme layer's parent is word); we mirror the cascade locally so the
  // UI updates without a refetch.
  async deleteToken(tokenId) {
    return this._withSaving('Failed to delete token', async () => {
      const info = this.layerInfo;
      const wordTokens = info.primaryTokenLayer?.tokens || [];
      const target = wordTokens.find(t => t.id === tokenId);
      const removedMorphIds = new Set();
      if (target) {
        (info.morphemeTokenLayer?.tokens || []).forEach(m => {
          if (m.begin === target.begin && m.end === target.end) removedMorphIds.add(m.id);
        });
      }

      await this._client.tokens.delete(tokenId);

      this._applyRawPatch((next, infoNext) => {
        if (infoNext.primaryTokenLayer?.tokens) {
          infoNext.primaryTokenLayer.tokens = infoNext.primaryTokenLayer.tokens.filter(t => t.id !== tokenId);
        }
        if (removedMorphIds.size > 0 && infoNext.morphemeTokenLayer?.tokens) {
          infoNext.morphemeTokenLayer.tokens = infoNext.morphemeTokenLayer.tokens.filter(m => !removedMorphIds.has(m.id));
        }
        // Drop any spans pinned to the deleted word or its morphemes.
        const deadIds = new Set([tokenId, ...removedMorphIds]);
        const filterSpansOn = (spanLayers) => {
          (spanLayers || []).forEach(sl => {
            if (!Array.isArray(sl.spans)) return;
            sl.spans = sl.spans.filter(s =>
              !(Array.isArray(s.tokens) && s.tokens.some(tid => deadIds.has(tid)))
            );
          });
        };
        filterSpansOn(infoNext.spanLayers?.word);
        filterSpansOn(infoNext.spanLayers?.morpheme);
      });
    });
  },

  // Create a word token at character range [begin, end). When sentences
  // exist, the range must fit inside one (sentences partition the doc).
  async createToken(begin, end) {
    const info = this.layerInfo;
    const primaryTokenLayer = info.primaryTokenLayer;
    const text = info.primaryTextLayer?.text;
    if (!primaryTokenLayer?.id || !text?.id) {
      this.setError('Token layer is not configured');
      return false;
    }
    const sentenceTokens = info.sentenceTokenLayer?.tokens || [];
    if (sentenceTokens.length > 0) {
      const fits = sentenceTokens.some(s => begin >= s.begin && end <= s.end);
      if (!fits) {
        this.setError('Selection must be inside an existing sentence');
        return false;
      }
    }

    return this._withSaving('Failed to create token', async () => {
      const result = await this._client.tokens.create(primaryTokenLayer.id, text.id, begin, end);
      const newId = result?.id || result;
      this._applyRawPatch((next, infoNext) => {
        if (!infoNext.primaryTokenLayer) return;
        if (!Array.isArray(infoNext.primaryTokenLayer.tokens)) infoNext.primaryTokenLayer.tokens = [];
        infoNext.primaryTokenLayer.tokens.push({
          id: newId,
          text: text.id,
          begin,
          end,
          metadata: {}
        });
      });
    });
  },

  // Built-in rule-based tokenization of any untokenized ranges of the body.
  // Cascade-heavy result on success, so we just reload rather than replay
  // locally. Returns true if anything was created, false otherwise.
  // Rule-based tokenize of untokenized body ranges. Returns the count of tokens
  // created (0 = already fully tokenized) on success, or null on failure — so
  // callers can distinguish "nothing to do" from an error (which is toasted here).
  async tokenize() {
    const info = this.layerInfo;
    const primaryTokenLayer = info.primaryTokenLayer;
    const text = info.primaryTextLayer?.text;
    if (!primaryTokenLayer?.id || !text?.id) {
      this.setError('Token layer is not configured');
      return null;
    }
    const body = this.body;
    if (!body || !body.trim()) {
      this.setError('No text to tokenize');
      return null;
    }

    let createdCount = 0;
    const ok = await this._withSaving('Failed to tokenize', async () => {
      const existingTokens = primaryTokenLayer.tokens || [];
      const ignoredTokensConfig = getIgnoredTokensConfig(this.project);
      const untokenizedRanges = findUntokenizedRanges(body, existingTokens);
      const newTokens = tokenizeText(body, ignoredTokensConfig, untokenizedRanges);
      const validation = validateTokenization(newTokens, body);
      if (!validation.isValid) {
        throw new Error(`Tokenization validation failed: ${validation.errors.join(', ')}`);
      }
      if (newTokens.length === 0) return;

      await this._client.tokens.bulkCreate(newTokens.map(t => ({
        tokenLayerId: primaryTokenLayer.id,
        text: text.id,
        begin: t.begin,
        end: t.end
      })));
      createdCount = newTokens.length;
      await this._reload();
    });
    return ok ? createdCount : null;
  },

  // Delete all word tokens. The server cascades to morphemes (and their
  // spans + vocab links). Reload after — the cascade is too sprawling to
  // replay locally.
  async clearTokens() {
    return this._withSaving('Failed to clear tokens', async () => {
      const info = this.layerInfo;
      const wordTokens = info.primaryTokenLayer?.tokens || [];
      if (wordTokens.length === 0) return;
      await this._client.tokens.bulkDelete(wordTokens.map(t => t.id));
      await this._reload();
    });
  }
};
