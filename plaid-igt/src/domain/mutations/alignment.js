// Mutation mixin: time-alignment operations (create/edit/delete alignment,
// align existing baseline text, resize alignment bounds). See IgtDocument.js
// for the `this` API.
//
// Alignment tokens live on a separate `:non-overlapping` token layer; each
// has a character range `[begin, end)` plus `{timeBegin, timeEnd}` metadata
// linking audio/video time to text. Editing the alignment's text also edits
// the body, which triggers the server's text-edit cascade — too sprawling
// to mirror locally, so create/edit/delete reload after a successful write.
// `alignBaseline` and `updateAlignmentBounds` skip the text edit and patch
// optimistically.
//
// Offsets (token begin/end, text-edit op index/value) are Unicode CODE POINTS,
// so measurement/slicing/search uses cpLength/cpSlice/cpIndexOf, not the UTF-16
// `.length`/`.substring`/`.indexOf` (which mis-place tokens around astral text).

import { cpLength, cpSlice, cpIndexOf } from '@larc-iu/plaid-client';

// Two ranges [a, b) and [c, d) overlap iff a < d && b > c.
const findOverlappingAlignment = (tokens, begin, end, excludeId = null) =>
  (tokens || []).find(t => t.id !== excludeId && t.begin < end && t.end > begin) || null;

const sortByBegin = (a, b) => a.begin - b.begin;

// Alignment-token metadata: the time bounds plus an optional speaker label
// (diarization). A blank speaker is omitted so we never persist an empty key.
const alignmentMeta = (timeBegin, timeEnd, speaker) => {
  const meta = { timeBegin, timeEnd };
  const s = (speaker || '').trim();
  if (s) meta.speaker = s;
  return meta;
};

// A token at text position `posBegin` with the given `timeBegin` inverts
// temporal order if it would sit earlier in time than its left positional
// neighbor, or later in time than its right one (temporal order must track
// text order). Returns 'previous' | 'next' | null.
const findTemporalInversion = (tokens, posBegin, timeBegin, excludeId = null) => {
  let left = null, right = null;
  for (const t of tokens || []) {
    if (t.id === excludeId) continue;
    if (t.begin < posBegin) { if (!left || t.begin > left.begin) left = t; }
    else if (t.begin > posBegin) { if (!right || t.begin < right.begin) right = t; }
  }
  if (left && timeBegin < (left.metadata?.timeBegin ?? -Infinity)) return 'previous';
  if (right && timeBegin > (right.metadata?.timeBegin ?? Infinity)) return 'next';
  return null;
};

export const alignmentMutations = {
  // Create a new alignment by inserting `text` into the body at a position
  // chosen to preserve temporal ordering, then creating the alignment token
  // over the inserted range with `{timeBegin, timeEnd}` metadata.
  async createAlignment({ text, timeBegin, timeEnd, speaker }) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      this.setError('Alignment text is required');
      return false;
    }
    if (timeEnd < timeBegin) {
      this.setError('Invalid time range: end must be at or after start');
      return false;
    }
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;
    if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
      this.setError('Required layers not found');
      return false;
    }
    const textId = primaryTextLayer.text?.id;
    if (!textId) {
      this.setError('Text layer not found');
      return false;
    }

    const existingText = this.body;
    const alignmentTokens = alignmentTokenLayer.tokens || [];
    const sortedTokens = [...alignmentTokens].sort(
      (a, b) => (a.metadata?.timeBegin || 0) - (b.metadata?.timeBegin || 0)
    );

    // Find the temporal neighbors of [timeBegin, timeEnd) so we can choose an
    // insertion offset that preserves temporal ordering on the text axis.
    let insertAfterToken = null;
    let insertBeforeToken = null;
    for (let i = 0; i < sortedTokens.length; i++) {
      const tokenTime = sortedTokens[i].metadata?.timeBegin || 0;
      if (tokenTime <= timeBegin) {
        insertAfterToken = sortedTokens[i];
      } else if (tokenTime > timeBegin && !insertBeforeToken) {
        insertBeforeToken = sortedTokens[i];
        break;
      }
    }

    let insertPosition;
    let temporalInversion = false;
    if (!insertAfterToken && !insertBeforeToken) {
      insertPosition = cpLength(existingText);
    } else if (!insertAfterToken && insertBeforeToken) {
      insertPosition = 0;
    } else if (insertAfterToken && !insertBeforeToken) {
      insertPosition = insertAfterToken.end;
    } else if (insertBeforeToken.begin < insertAfterToken.end) {
      // Temporal/positional ordering conflict — fall back to inserting
      // before the conflicting later-in-time token.
      insertPosition = insertBeforeToken.begin;
      temporalInversion = true;
    } else {
      insertPosition = insertAfterToken.end;
    }

    let insertedText;
    let insertBegin;
    let tokenBegin;
    let tokenEnd;
    if (insertPosition === 0) {
      const spaceAfter = existingText ? ' ' : '';
      insertedText = trimmed + spaceAfter;
      insertBegin = 0;
      tokenBegin = 0;
      tokenEnd = cpLength(trimmed);
    } else if (insertPosition >= cpLength(existingText)) {
      const spaceBefore = existingText ? ' ' : '';
      insertedText = spaceBefore + trimmed;
      insertBegin = cpLength(existingText);
      tokenBegin = cpLength(existingText) + (spaceBefore ? 1 : 0);
      tokenEnd = tokenBegin + cpLength(trimmed);
    } else {
      const before = cpSlice(existingText, 0, insertPosition);
      const after = cpSlice(existingText, insertPosition);
      const spaceBefore = before.endsWith(' ') ? '' : ' ';
      const spaceAfter = after.startsWith(' ') ? '' : ' ';
      insertedText = spaceBefore + trimmed + spaceAfter;
      insertBegin = insertPosition;
      tokenBegin = insertPosition + (spaceBefore ? 1 : 0);
      tokenEnd = tokenBegin + cpLength(trimmed);
    }

    if (temporalInversion) {
      this.setError('Cannot insert alignment: temporal and positional ordering conflict. Delete the conflicting alignment first.');
      return false;
    }
    // Overlap must be checked in POST-insert coordinates: the server's text-edit
    // cascade shifts every existing token at/after the insert point right by the
    // inserted length. Projecting first prevents a false "overlap" against a
    // temporal neighbor that the cascade moves clear (bug bash 2026-06-06: a
    // mid-insert between two single-space-separated alignments always tripped it).
    const shiftLen = cpLength(insertedText);
    const projectedTokens = alignmentTokens.map(t =>
      t.begin >= insertBegin ? { ...t, begin: t.begin + shiftLen, end: t.end + shiftLen } : t
    );
    const overlap = findOverlappingAlignment(projectedTokens, tokenBegin, tokenEnd);
    if (overlap) {
      this.setError('The new alignment range overlaps an existing alignment.');
      return false;
    }

    const newTextLength = cpLength(existingText) + cpLength(insertedText);
    const hasExistingSentences = (sentenceTokenLayer.tokens || []).length > 0;

    return this._withSaving('Failed to create alignment', async () => {
      await this._client.batched(async () => {
        this._client.texts.update(textId, [{ type: 'insert', index: insertBegin, value: insertedText }]);
        this._client.tokens.create(
          alignmentTokenLayer.id,
          textId,
          tokenBegin,
          tokenEnd,
          undefined,
          alignmentMeta(timeBegin, timeEnd, speaker)
        );
        // Empty partitioning layer: compensate-after-cascade skips it, so we
        // must seed the partition. Otherwise the cascade reindexes surviving
        // sentences to cover the inserted text.
        if (!hasExistingSentences && newTextLength > 0) {
          this._client.tokens.bulkCreate([{
            tokenLayerId: sentenceTokenLayer.id,
            text: textId,
            begin: 0,
            end: newTextLength
          }]);
        }
      });
      await this._reload();
      await this._rememberSpeaker(speaker);
    });
  },

  // Replace an existing alignment's text and time range. The cascade deletes
  // the old alignment token (it's fully contained in the deletion range), so
  // we recreate it alongside the text update.
  async editAlignment(existingAlignmentId, { text, timeBegin, timeEnd, speaker }) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      this.setError('Alignment text is required');
      return false;
    }
    if (timeEnd < timeBegin) {
      this.setError('Invalid time range: end must be at or after start');
      return false;
    }
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;
    if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
      this.setError('Required layers not found');
      return false;
    }
    const textId = primaryTextLayer.text?.id;
    if (!textId) {
      this.setError('Text layer not found');
      return false;
    }
    const alignmentTokens = alignmentTokenLayer.tokens || [];
    const existingAlignment = alignmentTokens.find(t => t.id === existingAlignmentId);
    if (!existingAlignment) {
      this.setError('Alignment not found');
      return false;
    }

    const currentText = this.body;
    const tokenBegin = existingAlignment.begin;
    const tokenEnd = existingAlignment.end;
    const newAlignmentEnd = tokenBegin + cpLength(trimmed);
    const newTextLength = cpLength(currentText) - (tokenEnd - tokenBegin) + cpLength(trimmed);

    const inversion = findTemporalInversion(alignmentTokens, tokenBegin, timeBegin, existingAlignmentId);
    if (inversion) {
      this.setError(`The new time range would put this alignment out of temporal order with the ${inversion} alignment.`);
      return false;
    }

    // Overlap check in POST-edit coordinates: replacing [tokenBegin, tokenEnd)
    // with `trimmed` shifts every later token by (newLen - oldLen). Without
    // projecting, growing the text past the next token reads as a false overlap.
    const editDelta = cpLength(trimmed) - (tokenEnd - tokenBegin);
    const projectedTokens = alignmentTokens.map(t =>
      (t.id !== existingAlignmentId && t.begin >= tokenEnd)
        ? { ...t, begin: t.begin + editDelta, end: t.end + editDelta }
        : t
    );
    const overlap = findOverlappingAlignment(projectedTokens, tokenBegin, newAlignmentEnd, existingAlignmentId);
    if (overlap) {
      this.setError('The updated alignment range would overlap an existing alignment.');
      return false;
    }

    // Explicit delete + insert (not a string update): a server-computed diff
    // can produce a narrower deletion range that leaves the alignment token
    // surviving and trips an ASSERT against tokens.create. Explicit ops over
    // exactly [tokenBegin, tokenEnd) guarantee the old token is cascaded out.
    const textOps = [
      { type: 'delete', index: tokenBegin, value: tokenEnd - tokenBegin },
      { type: 'insert', index: tokenBegin, value: trimmed }
    ];

    // Predict whether the cascade wipes the partition entirely (every
    // sentence sits inside the deletion range). If so, we re-seed it.
    // Otherwise some sentence survives and compensate-after-cascade covers
    // the new text — adding a bulkCreate would conflict with the
    // partition-establish ASSERT.
    const sentences = sentenceTokenLayer.tokens || [];
    const cascadeWipesAllSentences = sentences.length === 0
      || sentences.every(s => s.begin >= tokenBegin && s.end <= tokenEnd);

    return this._withSaving('Failed to edit alignment', async () => {
      await this._client.batched(async () => {
        this._client.texts.update(textId, textOps);
        this._client.tokens.create(
          alignmentTokenLayer.id,
          textId,
          tokenBegin,
          newAlignmentEnd,
          undefined,
          alignmentMeta(timeBegin, timeEnd, speaker)
        );
        if (cascadeWipesAllSentences && newTextLength > 0) {
          this._client.tokens.bulkCreate([{
            tokenLayerId: sentenceTokenLayer.id,
            text: textId,
            begin: 0,
            end: newTextLength
          }]);
        }
      });
      await this._reload();
      await this._rememberSpeaker(speaker);
    });
  },

  // Create an alignment over EXISTING body text without inserting any
  // characters. Locates `text` inside the available substring between
  // neighbor alignments and pins the new token to those absolute offsets.
  async alignBaseline({ text, timeBegin, timeEnd, speaker }) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      this.setError('Alignment text is required');
      return false;
    }
    if (timeEnd < timeBegin) {
      this.setError('Invalid time range: end must be at or after start');
      return false;
    }
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;
    if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
      this.setError('Required layers not found');
      return false;
    }
    const textId = primaryTextLayer.text?.id;
    if (!textId) {
      this.setError('Text layer not found');
      return false;
    }

    const alignmentTokens = alignmentTokenLayer.tokens || [];
    const fullText = this.body;
    const sortedTokens = [...alignmentTokens].sort(
      (a, b) => (a.metadata?.timeBegin || 0) - (b.metadata?.timeBegin || 0)
    );
    let leftBoundary = 0;
    let rightBoundary = cpLength(fullText);
    for (const token of sortedTokens) {
      const tokenTimeBegin = token.metadata?.timeBegin || 0;
      const tokenTimeEnd = token.metadata?.timeEnd || 0;
      if (tokenTimeEnd <= timeBegin && token.end > leftBoundary) {
        leftBoundary = token.end;
      }
      if (tokenTimeBegin >= timeEnd && token.begin < rightBoundary) {
        rightBoundary = token.begin;
      }
    }

    const availableText = cpSlice(fullText, leftBoundary, rightBoundary);
    const startInAvailable = cpIndexOf(availableText, trimmed);
    if (startInAvailable === -1) {
      // Distinguish "text isn't in the body at all" from "text is present but
      // lies outside the time-ordered window between neighboring alignments"
      // (the latter would otherwise misleadingly read as 'not found').
      const existsAnywhere = cpIndexOf(fullText, trimmed) !== -1;
      this.setError(existsAnywhere
        ? 'The selected text lies outside the range available for this time slot — a neighboring alignment would be out of temporal order. Adjust the time range or the neighboring alignments.'
        : 'Selected text not found in the baseline.');
      return false;
    }
    const actualBegin = leftBoundary + startInAvailable;
    const actualEnd = actualBegin + cpLength(trimmed);

    const overlap = findOverlappingAlignment(alignmentTokens, actualBegin, actualEnd);
    if (overlap) {
      this.setError('The selected text range overlaps an existing alignment.');
      return false;
    }

    return this._withSaving('Failed to align baseline text', async () => {
      const result = await this._client.tokens.create(
        alignmentTokenLayer.id,
        textId,
        actualBegin,
        actualEnd,
        undefined,
        alignmentMeta(timeBegin, timeEnd, speaker)
      );
      const newId = result?.id || result;
      this._applyRawPatch((next, infoNext) => {
        if (!infoNext.alignmentTokenLayer) return;
        if (!Array.isArray(infoNext.alignmentTokenLayer.tokens)) {
          infoNext.alignmentTokenLayer.tokens = [];
        }
        infoNext.alignmentTokenLayer.tokens.push({
          id: newId,
          text: textId,
          begin: actualBegin,
          end: actualEnd,
          metadata: alignmentMeta(timeBegin, timeEnd, speaker)
        });
        infoNext.alignmentTokenLayer.tokens.sort(sortByBegin);
      });
      await this._rememberSpeaker(speaker);
    });
  },

  // Delete an alignment by deleting its body text (the cascade then deletes
  // the alignment token). Swallows the surrounding inter-token whitespace so
  // we don't leave a double space.
  async deleteAlignment(alignmentId) {
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    if (!primaryTextLayer || !alignmentTokenLayer) {
      this.setError('Required layers not found');
      return false;
    }
    const textId = primaryTextLayer.text?.id;
    if (!textId) {
      this.setError('Text layer not found');
      return false;
    }
    const existingAlignment = (alignmentTokenLayer.tokens || []).find(t => t.id === alignmentId);
    if (!existingAlignment) {
      this.setError('Alignment not found');
      return false;
    }

    const currentText = this.body;
    const tokenBegin = existingAlignment.begin;
    const tokenEnd = existingAlignment.end;
    let beforeText = cpSlice(currentText, 0, tokenBegin);
    let afterText = cpSlice(currentText, tokenEnd);
    beforeText = beforeText.replace(/\s+$/, '');
    afterText = afterText.replace(/^\s+/, '');
    const numDeleted = cpLength(currentText) - (cpLength(afterText) + cpLength(beforeText));
    const index = cpLength(beforeText);

    return this._withSaving('Failed to delete alignment', async () => {
      await this._client.texts.update(textId, [{ type: 'delete', index, value: numDeleted }]);
      await this._reload();
    });
  },

  // Resize: just metadata. No text edit, no cascade. Patches the alignment's
  // metadata in place.
  async updateAlignmentBounds(alignmentId, { timeBegin, timeEnd }) {
    const info = this.layerInfo;
    const alignmentTokenLayer = info.alignmentTokenLayer;
    const token = (alignmentTokenLayer?.tokens || []).find(t => t.id === alignmentId);
    if (!token) {
      this.setError('Alignment not found');
      return false;
    }
    if (timeEnd < timeBegin) {
      this.setError('Invalid time range: end must be at or after start');
      return false;
    }
    // Bounds are metadata-only with no _reload, so a temporal/positional
    // inversion here would persist silently. Guard it like createAlignment does.
    const inversion = findTemporalInversion(alignmentTokenLayer?.tokens || [], token.begin, timeBegin, alignmentId);
    if (inversion) {
      this.setError(`The new time range would put this alignment out of temporal order with the ${inversion} alignment.`);
      return false;
    }

    return this._withSaving('Failed to update alignment boundaries', async () => {
      // PATCH (shallow-merge), not setMetadata (full replace): a manual boundary
      // drag must preserve the segment's provenance (prov/provSource/provDetail),
      // and per the cross-app convention "any human edit verifies" we stamp
      // provConfirmed. setMetadata would wipe prov, recording a machine-made
      // segment as origin-less.
      await this._client.tokens.patchMetadata(alignmentId, { timeBegin, timeEnd, provConfirmed: true });
      this._applyRawPatch((next, infoNext) => {
        const t = (infoNext.alignmentTokenLayer?.tokens || []).find(x => x.id === alignmentId);
        if (t) {
          t.metadata = { ...(t.metadata || {}), timeBegin, timeEnd, provConfirmed: true };
        }
      });
    });
  },

  // Speaker-only edit (diarization): patch just the `speaker` label on an
  // alignment token. No text edit, no cascade, no token churn — so relabeling a
  // segment's speaker never rewrites the baseline or the sentence partition and
  // never changes the token id. A blank value clears the label (patchMetadata
  // deletes a key whose value is null).
  async updateAlignmentSpeaker(alignmentId, speaker) {
    const info = this.layerInfo;
    const token = (info.alignmentTokenLayer?.tokens || []).find(t => t.id === alignmentId);
    if (!token) {
      this.setError('Alignment not found');
      return false;
    }
    const value = (speaker || '').trim();
    return this._withSaving('Failed to update speaker', async () => {
      await this._client.tokens.patchMetadata(alignmentId, { speaker: value || null });
      this._applyRawPatch((next, infoNext) => {
        const t = (infoNext.alignmentTokenLayer?.tokens || []).find(x => x.id === alignmentId);
        if (t) {
          t.metadata = { ...(t.metadata || {}) };
          if (value) t.metadata.speaker = value;
          else delete t.metadata.speaker;
        }
      });
      await this._rememberSpeaker(value);
    });
  },

  // Delete every alignment token. No text edit; alignments live on their own
  // layer and don't partition the body. Reload after because individual
  // patches would be too noisy.
  async clearAlignments() {
    const info = this.layerInfo;
    const alignmentTokens = info.alignmentTokenLayer?.tokens || [];
    if (alignmentTokens.length === 0) return false;
    const ids = alignmentTokens.map(t => t.id);

    return this._withSaving('Failed to clear alignments', async () => {
      await this._client.tokens.bulkDelete(ids);
      await this._reload();
    });
  }
};
