// Mutation mixin: word-token operations. See IgtDocument.js for the `this`
// API (_queueWrite, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// The first two methods below, updateOrthography and splitToken, are the
// canonical template for the mutation
// mixins. Conventions to follow:
//
// - Every edit shows before the server answers, creates included. Validate
//   inputs (id lookups, layer presence) first: guard failures use
//   `refuse(message) + return false`. Then `_canWrite(label)`, the patch
//   (`_applyRawPatch`), and `_queueWrite(label, send)` with the server
//   calls, which runs after any write still in flight.
// - A row the edit creates goes in under a pending id and `_settle` swaps
//   the server's in (see mutations/pending.js). The send names every id
//   through `settledId`: an edit made while an earlier one was queued can
//   hold that one's pending ids. Ids handed in are settled on the way in
//   (see the end of IgtDocument.js).
// - Inside `_applyRawPatch((next, info, vocabs) => ...)`, re-resolve
//   layers/tokens via `info` — captured outer references point into the
//   OLD raw doc and mutating through them is a real bug.
// - Inside `_client.batched(async (b) => ...)`, every write goes on `b`: a
//   write made on `this._client` there leaves the transaction.
// - For batched ops, the order matters: the server runs a batch's ops
//   sequentially, so an op that depends on a prior shift must come AFTER it.
//
// updateOrthography — simplest case: single field update with metadata merge.
// splitToken — complex case: pre-cleanup of dependent tokens, atomic batch
//              with returned id, multi-step optimistic patch.

import {
  tokenizeText,
  findUntokenizedRanges,
  getIgnoredTokensConfig,
  validateTokenization,
} from '../../utils/tokenizationUtils.js';
import {
  applyMetadataOps,
  mergeMetadata,
  metadataOps,
  createdId,
  createdIds,
} from '@larc-iu/plaid-client';
import {
  newHalfMetadata,
  newHalfOps,
  survivingProvenance,
  survivorPatch,
} from '../tokenReshape.js';
import { reparentSpans, reparentVocabLinks } from './reparent.js';
import { applyMergeRules } from '../igtConstraints.js';
import { removeTokensLocally } from '../textEdits.js';
import { pendingId, settledId } from '@ui/domain/pendingIds.js';
import { notSetUp } from '@ui/domain/setupGuard.js';
import { builtinRun } from '../builtinVersion.js';
import { isTokenIgnored, readIgnoredTokens } from '../igtConfig.js';
import { cpSlice } from '@larc-iu/plaid-client';
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

// The tokens a new word over [begin, end) takes in: every token the
// ignored-tokens rule excludes that overlaps it. igt reads such a token as
// text (punctuation ud's Tokenize made, say), so a word made over that text
// takes its place, as it would over untokenized punctuation.
export const absorbedTokens = (info, body, begin, end) => {
  const layer = info.primaryTokenLayer;
  const cfg = readIgnoredTokens(layer?.config);
  return (layer?.tokens || []).filter(
    (t) => t.begin < end && t.end > begin && isTokenIgnored(cpSlice(body, t.begin, t.end), cfg),
  );
};

// The tokens a merge of `words` takes in: those absorbedTokens names over the
// merged extent, other than the words themselves.
export const mergeAbsorbs = (info, body, words) => {
  const list = [...(words || [])].sort((a, b) => a.begin - b.begin);
  if (list.length < 2) return [];
  const ids = new Set(list.map((w) => w.id));
  return absorbedTokens(info, body, list[0].begin, list[list.length - 1].end).filter(
    (t) => !ids.has(t.id),
  );
};

export const tokenMutations = {
  // Set or update a per-orthography metadata key (`orthog:<name>`) on a word
  // token. Orthographies derive from the token's metadata at render time, so
  // the patch is the metadata entry alone.
  async updateOrthography(tokenId, orthographyName, value) {
    const info = this.layerInfo;
    const token = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    if (!token) {
      this.refuse('Word not found');
      return false;
    }
    const label = `Failed to update ${orthographyName}`;
    if (!this._canWrite(label)) return false;
    // The one key, so the token's other metadata is never written from this copy.
    const ops = [{ op: 'set', path: [`orthog:${orthographyName}`], value }];
    this._applyRawPatch((next, infoNext) => {
      const t = (infoNext.primaryTokenLayer?.tokens || []).find((x) => x.id === tokenId);
      if (t) t.metadata = applyMetadataOps(t.metadata, ops);
    });
    return this._queueWrite(label, () =>
      this._client.tokens.patchMetadata(settledId(tokenId), ops),
    );
  },

  // Split a word token at `splitOffset` (relative to token.begin). Wipes any
  // coincident morpheme (same begin/end) in the same atomic batch — the
  // morpheme's analysis is invalidated by the new boundary and the server-
  // side cascade-split would otherwise produce two nonsense morphemes.
  // Returns true on success / false on guard failure or server error.
  async splitToken(tokenId, splitOffset) {
    const info = this.layerInfo;
    const token = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    if (!token) {
      this.refuse('Word not found');
      return false;
    }
    const label = 'Failed to split token';
    if (!this._canWrite(label)) return false;
    // A split next to whitespace (scissors either side of the space in a word
    // merged over two) goes around the whole run of it, so neither half
    // begins or ends with a space: the right half starts after the run and
    // the left half is trimmed back to its start. Offsets are code points.
    const at = token.begin + splitOffset + 1;
    const cps = Array.from(this.body);
    const ws = (i) => /\s/u.test(cps[i] ?? '');
    let leftEnd = at;
    let rightBegin = at;
    while (leftEnd > token.begin && ws(leftEnd - 1)) leftEnd -= 1;
    while (rightBegin < token.end && ws(rightBegin)) rightBegin += 1;
    if (leftEnd === token.begin || rightBegin === token.end) {
      leftEnd = at;
      rightBegin = at;
    }
    const coincident = (info.morphemeTokenLayer?.tokens || [])
      .filter((m) => m.begin === token.begin && m.end === token.end)
      .map((m) => m.id);
    // What the two halves carry: see domain/tokenReshape.js. The server
    // leaves the left half's metadata alone and gives the right half only the
    // provenance its layer preserves on a split, so both halves are stamped
    // here as one edit, and a transcription of the whole word stays off the
    // right half.
    const leftPatch = survivorPatch(token.metadata, {}, (m) => this.editStamp(m));
    const rightMetadata = newHalfMetadata(token.metadata, (m) => this.editStamp(m));
    const rightId = pendingId();

    const textId = info.primaryTextLayer?.text?.id;
    this._applyRawPatch((next, infoNext, vocabs) => {
      const t = (infoNext.primaryTokenLayer?.tokens || []).find((x) => x.id === tokenId);
      if (t) {
        t.end = leftEnd;
        if (leftPatch) t.metadata = mergeMetadata(t.metadata || {}, leftPatch);
      }
      if (infoNext.primaryTokenLayer) {
        if (!Array.isArray(infoNext.primaryTokenLayer.tokens))
          infoNext.primaryTokenLayer.tokens = [];
        infoNext.primaryTokenLayer.tokens.push({
          id: rightId,
          begin: rightBegin,
          end: token.end,
          metadata: rightMetadata ? { ...rightMetadata } : {},
        });
        infoNext.primaryTokenLayer.tokens.sort((a, b) => a.begin - b.begin);
      }
      // The coincident morphemes go with their annotations and links
      // (HUNT-model M5).
      if (coincident.length > 0) removeTokensLocally(next, textId, coincident, vocabs);
    });

    // One batch, the halves' metadata with the split: the right half is made
    // under the id this page minted, so the batch can name it.
    return this._queueWrite(label, async () => {
      const id = settledId(tokenId);
      await this._client.batched(async (b) => {
        if (coincident.length > 0) b.tokens.bulkDelete(coincident.map(settledId));
        b.tokens.split(id, rightBegin, undefined, { id: rightId });
        if (leftEnd < rightBegin) b.tokens.update(id, undefined, leftEnd);
        if (leftPatch) b.tokens.patchMetadata(id, metadataOps(leftPatch));
        const rightOps = newHalfOps(token.metadata, rightMetadata);
        if (rightOps.length) b.tokens.patchMetadata(rightId, rightOps);
      });
      this._settle(new Map([[rightId, rightId]]));
    });
  },

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
      this.refuse('Not enough tokens to merge');
      return false;
    }
    const label = 'Failed to merge tokens';
    if (!this._canWrite(label)) return false;

    const firstToken = toMerge[0];
    const lastToken = toMerge[toMerge.length - 1];
    const coincident = findCoincidentMorphemeIds(info.morphemeTokenLayer?.tokens || [], toMerge);
    // What the survivor had before the merge, which the server's rules keep
    // over what the merge moves onto it, and where each moved annotation's
    // word began, which orders their values in the join.
    const onlyOn = (tokens, id) => Array.isArray(tokens) && tokens.length === 1 && tokens[0] === id;
    const own = {
      spans: new Set(
        (info.spanLayers?.word || []).flatMap((sl) =>
          (sl.spans || []).filter((sp) => onlyOn(sp.tokens, firstToken.id)).map((sp) => sp.id),
        ),
      ),
      links: new Set(
        Object.values(this._vocabularies || {}).flatMap((v) =>
          (v.vocabLinks || []).filter((l) => onlyOn(l.tokens, firstToken.id)).map((l) => l.id),
        ),
      ),
    };
    const beginOf = new Map();
    for (const sl of info.spanLayers?.word || []) {
      for (const sp of sl.spans || []) {
        const word = toMerge.find((t) => onlyOn(sp.tokens, t.id));
        if (word) beginOf.set(sp.id, word.begin);
      }
    }

    // What the survivor carries: see domain/tokenReshape.js. The server keeps
    // its metadata and discards the rest, so merging a hand-made word with a
    // machine-made one would absorb the machine origin and leave a
    // transcription of one word standing for several.
    const inherited = survivingProvenance(toMerge.map((t) => t.metadata));
    const patch = survivorPatch(firstToken.metadata, inherited, (m) => this.editStamp(m));
    const removedWordIds = new Set(toMerge.slice(1).map((t) => t.id));
    const removedMorphIds = new Set(coincident);
    // Punctuation tokens between the words (ud's, say) read as text here, so
    // the merged word takes their place, as it would over untokenized text.
    const absorbed = mergeAbsorbs(info, this.body, toMerge).map((t) => t.id);
    const textId = info.primaryTextLayer?.text?.id;

    this._applyRawPatch((next, infoNext, vocabs) => {
      if (absorbed.length) removeTokensLocally(next, textId, absorbed, vocabs);
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
      // The reparent can leave the survivor two annotations in one field and
      // two links. The server's layer rules settle them in the merge's own
      // transaction (igtConstraints.js), and the screen shows the same.
      applyMergeRules(infoNext, vocabs, firstToken.id, beginOf, own);
    });

    return this._queueWrite(label, async () => {
      const first = settledId(firstToken.id);
      await this._client.batched(async (b) => {
        if (coincident.length > 0) b.tokens.bulkDelete(coincident.map(settledId));
        if (absorbed.length > 0) b.tokens.bulkDelete(absorbed.map(settledId));
        // Sequential merges into firstToken in begin-order. The server processes
        // batch ops sequentially, so each merge sees firstToken's widened extent.
        for (let i = 1; i < toMerge.length; i++) {
          b.tokens.merge(first, settledId(toMerge[i].id));
        }
        if (patch) b.tokens.patchMetadata(first, metadataOps(patch));
      });
    });
  },

  // Delete a single word token. The server cascades the morpheme deletion
  // (morpheme layer's parent is word); the cascade is mirrored locally.
  async deleteToken(tokenId) {
    const info = this.layerInfo;
    const target = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    if (!target) {
      this.refuse('Word not found');
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
      this.refuse(notSetUp('Token layer is not configured'));
      return false;
    }
    const sentenceTokens = info.sentenceTokenLayer?.tokens || [];
    if (sentenceTokens.length > 0) {
      const fits = sentenceTokens.some((s) => begin >= s.begin && end <= s.end);
      if (!fits) {
        this.refuse('Selection must be inside an existing sentence');
        return false;
      }
    }
    const label = 'Failed to create token';
    if (!this._canWrite(label)) return false;
    const id = pendingId();
    const absorbed = absorbedTokens(info, this.body, begin, end).map((t) => t.id);
    this._applyRawPatch((next, infoNext, vocabs) => {
      if (absorbed.length) removeTokensLocally(next, text.id, absorbed, vocabs);
      pushWords(infoNext, text.id, [{ id, begin, end }]);
    });
    const create = (c) =>
      c.tokens.create(primaryTokenLayer.id, text.id, begin, end, undefined, undefined, undefined, {
        id,
      });
    return this._queueWrite(label, async () => {
      if (!absorbed.length) {
        this._settle(new Map([[id, createdId(await create(this._client))]]));
        return;
      }
      await this._client.batched(async (b) => {
        b.tokens.bulkDelete(absorbed.map(settledId));
        create(b);
      });
      this._settle(new Map([[id, id]]));
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
      this.refuse(notSetUp('Token layer is not configured'));
      return null;
    }
    const body = this.body;
    if (!body || !body.trim()) {
      this.refuse('No text to tokenize');
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
      this.refuse('Could not split the text into words.');
      return null;
    }
    if (newTokens.length === 0) return 0;
    const words = newTokens.map((t) => ({ id: pendingId(), begin: t.begin, end: t.end }));
    this._applyRawPatch((next, infoNext) => pushWords(infoNext, text.id, words));
    const send = async () => {
      const result = await this._client.tokens.bulkCreate(
        words.map((w) => ({
          id: w.id,
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
  // spans + vocab links); the cascade is mirrored locally. A token the
  // ignored-tokens rule excludes (punctuation ud's Tokenize made, say) reads
  // as text here and stays, so Clear deletes the words it counts and the
  // document reads as it does where that punctuation has no token.
  async clearTokens() {
    const info = this.layerInfo;
    const cfg = readIgnoredTokens(info.primaryTokenLayer?.config);
    const body = this.body;
    const wordTokens = (info.primaryTokenLayer?.tokens || []).filter(
      (t) => !isTokenIgnored(cpSlice(body, t.begin, t.end), cfg),
    );
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
