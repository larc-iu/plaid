// Mutation mixin: word-token operations. See IgtDocument.js for the `this`
// API (_queueWrite, _applyRawPatch, _reload, layerInfo, body, etc.) and the
// splitToken template method.

import {
  tokenizeText,
  findUntokenizedRanges,
  getIgnoredTokensConfig,
  validateTokenization,
} from '../../utils/tokenizationUtils.js';
import { mergeMetadata, metadataOps, createdId, createdIds } from '@larc-iu/plaid-client';
import { survivingProvenance, survivorPatch } from '../tokenReshape.js';
import { reparentSpans, reparentVocabLinks } from './reparent.js';
import { planSpanDedup, planVocabLinkDedup, applyVocabLinkDedup } from '../igtReconcile.js';
import { removeTokensLocally } from '../textEdits.js';
import { pendingId, settledId } from '@ui/domain/pendingIds.js';
import { notSetUp } from '@ui/domain/setupGuard.js';
import { builtinRun } from '../builtinVersion.js';
import { BUILTIN_TOKENIZE_RULE_BASED } from '../serviceDefaults.js';

const findCoincidentMorphemeIds = (morphemeTokens, targets) => {
  if (!Array.isArray(morphemeTokens) || morphemeTokens.length === 0) return [];
  const ranges = new Set(targets.map((t) => `${t.begin}-${t.end}`));
  const ids = [];
  morphemeTokens.forEach((m) => {
    if (ranges.has(`${m.begin}-${m.end}`)) ids.push(m.id);
  });
  return ids;
};

// New word tokens into the local layer, in begin order.
const pushWords = (infoNext, textId, words) => {
  const layer = infoNext.primaryTokenLayer;
  if (!layer) return;
  if (!Array.isArray(layer.tokens)) layer.tokens = [];
  words.forEach((w) => layer.tokens.push({ ...w, text: textId, metadata: {} }));
  layer.tokens.sort((a, b) => a.begin - b.begin);
};

export const tokenMutations = {
  // Merge a set of word tokens into the earliest-beginning one, which grows
  // to cover the rest. Coincident morphemes (same begin/end as any merged
  // word token) are deleted in the same atomic batch: their analysis is
  // invalidated by the new boundary, same rationale as splitToken.
  async mergeTokens(tokenIds) {
    const ids = tokenIds instanceof Set ? Array.from(tokenIds) : Array.from(tokenIds || []);
    if (ids.length <= 1) return false;
    const info = this.layerInfo;
    const wordTokens = info.primaryTokenLayer?.tokens || [];
    const idSet = new Set(ids);
    const toMerge = wordTokens.filter((t) => idSet.has(t.id)).sort((a, b) => a.begin - b.begin);
    if (toMerge.length <= 1) {
      this.setError('Not enough tokens to merge');
      return false;
    }
    const label = 'Failed to merge tokens';
    if (!this._canWrite(label)) return false;

    const firstToken = toMerge[0];
    const lastToken = toMerge[toMerge.length - 1];
    const coincident = findCoincidentMorphemeIds(info.morphemeTokenLayer?.tokens || [], toMerge);
    // The survivor's own pre-merge link wins the link dedup below.
    const ownLinkIds = new Set(
      Object.values(this._vocabularies || {}).flatMap((v) =>
        (v.vocabLinks || [])
          .filter(
            (l) =>
              Array.isArray(l.tokens) && l.tokens.length === 1 && l.tokens[0] === firstToken.id,
          )
          .map((l) => l.id),
      ),
    );

    // What the survivor carries: see domain/tokenReshape.js. The server keeps
    // its metadata and discards the rest, so merging a hand-made word with a
    // machine-made one would absorb the machine origin and leave a
    // transcription of one word standing for several.
    const inherited = survivingProvenance(toMerge.map((t) => t.metadata));
    const patch = survivorPatch(firstToken.metadata, inherited, (m) => this.editStamp(m));
    const removedWordIds = new Set(toMerge.slice(1).map((t) => t.id));
    const removedMorphIds = new Set(coincident);

    this._applyRawPatch((next, infoNext, vocabs) => {
      if (infoNext.primaryTokenLayer?.tokens) {
        const first = infoNext.primaryTokenLayer.tokens.find((t) => t.id === firstToken.id);
        if (first) {
          first.end = lastToken.end;
          if (patch) first.metadata = mergeMetadata(first.metadata || {}, patch);
        }
        infoNext.primaryTokenLayer.tokens = infoNext.primaryTokenLayer.tokens.filter(
          (t) => !removedWordIds.has(t.id),
        );
      }
      if (removedMorphIds.size > 0 && infoNext.morphemeTokenLayer?.tokens) {
        infoNext.morphemeTokenLayer.tokens = infoNext.morphemeTokenLayer.tokens.filter(
          (m) => !removedMorphIds.has(m.id),
        );
      }
      // Server reparents word-scope spans + vocab links from the merged-away
      // words onto firstToken (token.clj merge-tokens); mirror that so they
      // don't vanish until the next reload. Morpheme-scope spans/links on the
      // deleted coincident morphemes are cascade-DELETED server-side, so they
      // are correctly left to drop out (orphaned, never rendered).
      reparentSpans(infoNext.spanLayers?.word, removedWordIds, firstToken.id);
      reparentVocabLinks(vocabs, removedWordIds, firstToken.id);
    });

    // The reparent above can leave the survivor with >1 span in the same layer
    // (each merged word's word-scope span now points at it). Dedup at once:
    // lossless join, identical to reconcile-on-open, so the duplicate never
    // persists: it was invisible in the editor and silently dropped by a
    // list-level export until the next Analyze open healed it (and it was what
    // triggered the "Document repaired" toast on reopen).
    const dedup = planSpanDedup(this.layerInfo).filter((p) => p.deleteSpanIds.length > 0);
    if (dedup.length > 0) {
      this._applyRawPatch((next, infoNext) => {
        for (const p of dedup) {
          for (const sl of infoNext.spanLayers?.[p.scope] || []) {
            if (sl.id !== p.layerId || !Array.isArray(sl.spans)) continue;
            const dead = new Set(p.deleteSpanIds);
            sl.spans = sl.spans.filter((s) => !dead.has(s.id));
            const keep = sl.spans.find((s) => s.id === p.keepSpanId);
            if (keep && p.needsUpdate) keep.value = p.mergedValue;
          }
        }
      });
    }
    // Same for vocab links: the reparent leaves the survivor with one link per
    // merged word that had one, and the editor shows/unlinks only one. Keep
    // the survivor's own link (else the earliest merged word's), delete the rest.
    const linkPlans = planVocabLinkDedup(this._vocabularies, ownLinkIds);
    if (linkPlans.length > 0) {
      this._applyRawPatch((next, infoNext, vocabs) => applyVocabLinkDedup(vocabs, linkPlans));
    }

    return this._queueWrite(label, async () => {
      const first = settledId(firstToken.id);
      await this._client.batched(async (b) => {
        if (coincident.length > 0) b.tokens.bulkDelete(coincident.map(settledId));
        // Sequential merges into firstToken in begin-order. The server processes
        // batch ops sequentially, so each merge sees firstToken's widened extent.
        for (let i = 1; i < toMerge.length; i++) {
          b.tokens.merge(first, settledId(toMerge[i].id));
        }
        if (patch) b.tokens.patchMetadata(first, metadataOps(patch));
      });
      if (dedup.length > 0 || linkPlans.length > 0) {
        await this._client.batched((b) => {
          for (const p of dedup) {
            if (p.needsUpdate) b.spans.update(settledId(p.keepSpanId), p.mergedValue);
            p.deleteSpanIds.forEach((id) => b.spans.delete(settledId(id)));
          }
          for (const p of linkPlans) {
            p.deleteLinks.forEach((l) => b.vocabLinks.delete(settledId(l.linkId)));
          }
        });
      }
    });
  },

  // Delete a single word token. The server cascades the morpheme deletion
  // (morpheme layer's parent is word); the cascade is mirrored locally.
  async deleteToken(tokenId) {
    const info = this.layerInfo;
    const target = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    if (!target) {
      this.setError('Word not found');
      return false;
    }
    const label = 'Failed to delete token';
    if (!this._canWrite(label)) return false;
    const textId = info.primaryTextLayer?.text?.id;
    const morphIds = (info.morphemeTokenLayer?.tokens || [])
      .filter((m) => m.begin === target.begin && m.end === target.end)
      .map((m) => m.id);
    this._applyRawPatch((next, infoNext, vocabs) =>
      removeTokensLocally(next, textId, [tokenId, ...morphIds], vocabs),
    );
    return this._queueWrite(label, () => this._client.tokens.delete(settledId(tokenId)));
  },

  // Create a word token at character range [begin, end). When sentences
  // exist, the range must fit inside one (sentences partition the doc).
  async createToken(begin, end) {
    const info = this.layerInfo;
    const primaryTokenLayer = info.primaryTokenLayer;
    const text = info.primaryTextLayer?.text;
    if (!primaryTokenLayer?.id || !text?.id) {
      this.setError(notSetUp('Token layer is not configured'));
      return false;
    }
    const sentenceTokens = info.sentenceTokenLayer?.tokens || [];
    if (sentenceTokens.length > 0) {
      const fits = sentenceTokens.some((s) => begin >= s.begin && end <= s.end);
      if (!fits) {
        this.setError('Selection must be inside an existing sentence');
        return false;
      }
    }
    const label = 'Failed to create token';
    if (!this._canWrite(label)) return false;
    const id = pendingId();
    this._applyRawPatch((next, infoNext) => pushWords(infoNext, text.id, [{ id, begin, end }]));
    return this._queueWrite(label, async () => {
      const result = await this._client.tokens.create(primaryTokenLayer.id, text.id, begin, end);
      this._settle(new Map([[id, createdId(result)]]));
    });
  },

  // Rule-based tokenize of untokenized body ranges. Returns the count of tokens
  // created (0 = already fully tokenized) on success, or null on failure, so
  // callers can distinguish "nothing to do" from an error (which is toasted
  // here). The new words show at once.
  async tokenize() {
    const info = this.layerInfo;
    const primaryTokenLayer = info.primaryTokenLayer;
    const text = info.primaryTextLayer?.text;
    if (!primaryTokenLayer?.id || !text?.id) {
      this.setError(notSetUp('Token layer is not configured'));
      return null;
    }
    const body = this.body;
    if (!body || !body.trim()) {
      this.setError('No text to tokenize');
      return null;
    }
    const label = 'Failed to tokenize';
    if (!this._canWrite(label)) return null;
    const ignoredTokensConfig = getIgnoredTokensConfig(this.project);
    const untokenizedRanges = findUntokenizedRanges(body, primaryTokenLayer.tokens || []);
    const newTokens = tokenizeText(body, ignoredTokensConfig, untokenizedRanges);
    const validation = validateTokenization(newTokens, body);
    if (!validation.isValid) {
      console.error(`Tokenization validation failed: ${validation.errors.join(', ')}`);
      this.setError('Could not split the text into words.');
      return null;
    }
    if (newTokens.length === 0) return 0;
    const words = newTokens.map((t) => ({ id: pendingId(), begin: t.begin, end: t.end }));
    this._applyRawPatch((next, infoNext) => pushWords(infoNext, text.id, words));
    const send = async () => {
      const result = await this._client.tokens.bulkCreate(
        words.map((w) => ({
          tokenLayerId: primaryTokenLayer.id,
          text: text.id,
          begin: w.begin,
          end: w.end,
        })),
      );
      const newIds = createdIds(result);
      this._settle(new Map(words.map((w, i) => [w.id, newIds[i]])));
    };
    // A service run in the audit log, naming the rule. The words carry no
    // provenance: tokens are substrate, which the convention leaves unstamped.
    const ok = await this._queueWrite(
      label,
      send,
      undefined,
      builtinRun(BUILTIN_TOKENIZE_RULE_BASED),
    );
    return ok ? words.length : null;
  },

  // Delete all word tokens. The server cascades to morphemes (and their
  // spans + vocab links); the cascade is mirrored locally.
  async clearTokens() {
    const info = this.layerInfo;
    const wordTokens = info.primaryTokenLayer?.tokens || [];
    if (wordTokens.length === 0) return true;
    const label = 'Failed to clear tokens';
    if (!this._canWrite(label)) return false;
    const textId = info.primaryTextLayer?.text?.id;
    const wordIds = wordTokens.map((t) => t.id);
    const morphIds = (info.morphemeTokenLayer?.tokens || []).map((m) => m.id);
    this._applyRawPatch((next, infoNext, vocabs) =>
      removeTokensLocally(next, textId, [...wordIds, ...morphIds], vocabs),
    );
    return this._queueWrite(label, () => this._client.tokens.bulkDelete(wordIds.map(settledId)));
  },
};
