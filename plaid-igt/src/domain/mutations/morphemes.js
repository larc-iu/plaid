// Mutation mixin: morpheme operations. See IgtDocument.js for the `this`
// API (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// IGT morpheme model: morphemes share their parent word's begin/end (no
// sub-range; MWTs are multiple morphemes at the same extent). Order within
// the word is 1-based contiguous `precedence`. Insert/remove/reorder must
// renumber so precedence stays gap-free.
//
// Guard convention (matches the rest of src/domain/mutations): "couldn't
// resolve this id" / "no-op condition" guards do `setError + return false`
// outside `_withSaving` so we don't trigger a needless `_reload` for an
// invalid input. `throw` inside `_withSaving` is reserved for unexpected
// failure paths the server is reporting.

import { cpSlice, verifyOnEdit } from '@larc-iu/plaid-client';
import { isValidMorphType } from '../affixMarkers.js';

// A human edit of a machine-made, unverified morpheme verifies its
// segmentation (provenance write-contract rule 3): merge { provConfirmed:
// true } into the same metadata patch. Null-safe spread for human morphemes.
const verified = (morpheme, patch) => ({ ...patch, ...(verifyOnEdit(morpheme?.metadata) || {}) });

const morphemesInWord = (morphemeTokens, word) =>
  (morphemeTokens || []).filter(m => m.begin === word.begin && m.end === word.end);

const sortByPrecedence = (ms) =>
  [...ms].sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));

const formOf = (morpheme, body) => {
  const meta = morpheme?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return cpSlice(body, morpheme.begin, morpheme.end);
};

export const morphemeMutations = {
  // Append a new morpheme to a word; precedence = (existing count) + 1.
  async createMorpheme(wordTokenId, form) {
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    if (!morphemeLayer?.id || !textId) {
      this.setError('Morpheme layer not configured');
      return false;
    }
    const word = (info.primaryTokenLayer?.tokens || []).find(t => t.id === wordTokenId);
    if (!word) {
      this.setError(`Word ${wordTokenId} not found`);
      return false;
    }

    return this._withSaving('Failed to create morpheme', async () => {
      const existing = morphemesInWord(morphemeLayer.tokens, word);
      const precedence = existing.length + 1;
      const metadata = form ? { form } : undefined;

      const result = await this._client.tokens.create(
        morphemeLayer.id,
        textId,
        word.begin,
        word.end,
        precedence,
        metadata
      );
      const newId = result?.id || result;

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer) return;
        if (!Array.isArray(layer.tokens)) layer.tokens = [];
        layer.tokens.push({
          id: newId,
          text: textId,
          begin: word.begin,
          end: word.end,
          precedence,
          metadata: form ? { form } : {}
        });
      });
    });
  },

  // Batched append of N morphemes to a word. Used by the MWT-split flow
  // where a single form is split into several at once. Precedences are
  // assigned starting from (existing count) + 1 in order.
  async createMorphemes(wordTokenId, forms) {
    if (!Array.isArray(forms) || forms.length === 0) return false;
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    if (!morphemeLayer?.id || !textId) {
      this.setError('Morpheme layer not configured');
      return false;
    }
    const word = (info.primaryTokenLayer?.tokens || []).find(t => t.id === wordTokenId);
    if (!word) {
      this.setError(`Word ${wordTokenId} not found`);
      return false;
    }

    return this._withSaving('Failed to create morphemes', async () => {
      const existing = morphemesInWord(morphemeLayer.tokens, word);
      const basePrecedence = existing.length + 1;

      const results = await this._client.batched(async () => {
        forms.forEach((form, i) => {
          this._client.tokens.create(
            morphemeLayer.id,
            textId,
            word.begin,
            word.end,
            basePrecedence + i,
            form ? { form } : undefined
          );
        });
      });
      const newIds = forms.map((_, i) => results[i]?.body?.id);

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer) return;
        if (!Array.isArray(layer.tokens)) layer.tokens = [];
        forms.forEach((form, i) => {
          const id = newIds[i];
          if (!id) return;
          layer.tokens.push({
            id,
            text: textId,
            begin: word.begin,
            end: word.end,
            precedence: basePrecedence + i,
            metadata: form ? { form } : {}
          });
        });
      });
    });
  },

  // Split a morpheme's form into two: existing gets `leftForm`, a new one
  // with `rightForm` is inserted at the next precedence; subsequent morphemes
  // shift +1.
  async splitMorpheme(morphemeId, leftForm, rightForm) {
    return this.splitMorphemeMulti(morphemeId, [leftForm, rightForm]);
  },

  // N-way generalization (paste-splitting): replace one morpheme with
  // `segments` — the existing morpheme keeps segments[0] as its form (and its
  // annotations/links), segments[1..] are inserted after it; subsequent
  // morphemes shift by segments.length - 1.
  //
  // Batch order: setMetadata, then shift subsequents in descending precedence
  // to free the target slots, then create at the freed slots. The creates
  // MUST run AFTER the shifts — if a new (begin, end, precedence) triple
  // collides with an existing morpheme's it's a server-side 409.
  async splitMorphemeMulti(morphemeId, segments) {
    if (!Array.isArray(segments) || segments.length < 2) {
      this.setError('splitMorphemeMulti needs at least two segments');
      return false;
    }
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    if (!morphemeLayer?.id || !textId) {
      this.setError('Morpheme layer not configured');
      return false;
    }
    const target = (morphemeLayer.tokens || []).find(m => m.id === morphemeId);
    if (!target) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }

    return this._withSaving('Failed to split morpheme', async () => {
      const firstForm = segments[0];
      const restForms = segments.slice(1);
      const siblings = sortByPrecedence(morphemesInWord(morphemeLayer.tokens, target));
      const currentPrecedence = target.precedence ?? siblings.findIndex(m => m.id === morphemeId) + 1;
      const subsequents = siblings.filter(m => (m.precedence ?? 0) > currentPrecedence);
      const shifted = [...subsequents].sort((a, b) => (b.precedence ?? 0) - (a.precedence ?? 0));

      const results = await this._client.batched(async () => {
        // patch, not set: form edits must not clobber other metadata keys
        // (morphType from the FLEx import, in particular)
        this._client.tokens.patchMetadata(morphemeId, verified(target, { form: firstForm }));
        shifted.forEach(m => {
          this._client.tokens.update(m.id, undefined, undefined, (m.precedence ?? 0) + restForms.length);
        });
        restForms.forEach((form, i) => {
          this._client.tokens.create(
            morphemeLayer.id,
            textId,
            target.begin,
            target.end,
            currentPrecedence + 1 + i,
            form ? { form } : undefined
          );
        });
      });
      // setMetadata is 0; shifts are 1..S (S = shifted.length); creates follow.
      const newIds = restForms.map((_, i) => results[shifted.length + 1 + i]?.body?.id);

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer) return;
        const tokens = layer.tokens || [];
        const t = tokens.find(m => m.id === morphemeId);
        if (t) {
          t.metadata = { ...(t.metadata || {}), ...verified(target, { form: firstForm }) };
        }
        tokens.forEach(m => {
          if (m.begin === target.begin && m.end === target.end && (m.precedence ?? 0) > currentPrecedence) {
            m.precedence = (m.precedence ?? 0) + restForms.length;
          }
        });
        if (!Array.isArray(layer.tokens)) layer.tokens = [];
        restForms.forEach((form, i) => {
          const id = newIds[i];
          if (!id) return;
          layer.tokens.push({
            id,
            text: textId,
            begin: target.begin,
            end: target.end,
            precedence: currentPrecedence + 1 + i,
            metadata: form ? { form } : {}
          });
        });
      });
    });
  },

  // Merge a morpheme into its predecessor within the same word. Returns
  // false silently when there's no previous (the caller's Backspace-at-start
  // shortcut is a no-op there, not an error).
  async mergeMorphemes(morphemeId) {
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const target = (morphemeLayer?.tokens || []).find(m => m.id === morphemeId);
    if (!target) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }
    const siblings = sortByPrecedence(morphemesInWord(morphemeLayer.tokens, target));
    const idx = siblings.findIndex(m => m.id === morphemeId);
    if (idx <= 0) return false;
    const previous = siblings[idx - 1];

    return this._withSaving('Failed to merge morphemes', async () => {
      const body = this.body;
      const previousForm = formOf(previous, body);
      const currentForm = formOf(target, body);
      const mergedForm = previousForm + currentForm;
      const subsequents = siblings.slice(idx + 1);

      await this._client.batched(async () => {
        this._client.tokens.patchMetadata(previous.id, verified(previous, { form: mergedForm }));
        this._client.tokens.delete(morphemeId);
        subsequents.forEach(m => {
          this._client.tokens.update(m.id, undefined, undefined, (m.precedence ?? 0) - 1);
        });
      });

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer || !Array.isArray(layer.tokens)) return;
        const prev = layer.tokens.find(m => m.id === previous.id);
        if (prev) prev.metadata = { ...(prev.metadata || {}), ...verified(previous, { form: mergedForm }) };
        layer.tokens = layer.tokens.filter(m => m.id !== morphemeId);
        layer.tokens.forEach(m => {
          if (m.begin === target.begin && m.end === target.end && (m.precedence ?? 0) > (target.precedence ?? 0)) {
            m.precedence = (m.precedence ?? 0) - 1;
          }
        });
      });
    });
  },

  // Delete a single morpheme. Refuses to delete the last morpheme of a word
  // (the data model allows wordless morphemes but the editor's contract is
  // "every word has at least one morpheme"; UI used to enforce, we enforce
  // here so the next UI doesn't have to).
  async deleteMorpheme(morphemeId) {
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const target = (morphemeLayer?.tokens || []).find(m => m.id === morphemeId);
    if (!target) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }
    const siblings = sortByPrecedence(morphemesInWord(morphemeLayer.tokens, target));
    if (siblings.length <= 1) {
      this.setError('Cannot delete the last morpheme of a word');
      return false;
    }

    return this._withSaving('Failed to delete morpheme', async () => {
      const subsequents = siblings.filter(m => (m.precedence ?? 0) > (target.precedence ?? 0));

      await this._client.batched(async () => {
        this._client.tokens.delete(morphemeId);
        subsequents.forEach(m => {
          this._client.tokens.update(m.id, undefined, undefined, (m.precedence ?? 0) - 1);
        });
      });

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer || !Array.isArray(layer.tokens)) return;
        layer.tokens = layer.tokens.filter(m => m.id !== morphemeId);
        layer.tokens.forEach(m => {
          if (m.begin === target.begin && m.end === target.end && (m.precedence ?? 0) > (target.precedence ?? 0)) {
            m.precedence = (m.precedence ?? 0) - 1;
          }
        });
      });
    });
  },

  // Update a morpheme's form (single metadata patch — other keys survive).
  async updateMorphemeForm(morphemeId, form) {
    const info = this.layerInfo;
    const target = (info.morphemeTokenLayer?.tokens || []).find(m => m.id === morphemeId);
    if (!target) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }

    return this._withSaving('Failed to update morpheme form', async () => {
      const patch = verified(target, { form });
      await this._client.tokens.patchMetadata(morphemeId, patch);

      this._applyRawPatch((next, infoNext) => {
        const m = (infoNext.morphemeTokenLayer?.tokens || []).find(x => x.id === morphemeId);
        if (m) m.metadata = { ...(m.metadata || {}), ...patch };
      });
    });
  },

  // Set or clear (null) a morpheme's type — metadata.morphType, constrained
  // to FLEx's exact inventory (FLEX_MORPH_TYPES). Pure metadata: geometry,
  // precedence, and the stored form are untouched, so no token invariant can
  // be violated; display-side affix joints react automatically.
  async setMorphemeType(morphemeId, morphType) {
    if (!isValidMorphType(morphType)) {
      this.setError(`Unknown morpheme type "${morphType}"`);
      return false;
    }
    const info = this.layerInfo;
    const target = (info.morphemeTokenLayer?.tokens || []).find(m => m.id === morphemeId);
    if (!target) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }

    return this._withSaving('Failed to set morpheme type', async () => {
      // patch semantics: a null value deletes the key
      const confirm = verifyOnEdit(target.metadata) || {};
      await this._client.tokens.patchMetadata(morphemeId, { morphType: morphType ?? null, ...confirm });

      this._applyRawPatch((next, infoNext) => {
        const m = (infoNext.morphemeTokenLayer?.tokens || []).find(x => x.id === morphemeId);
        if (!m) return;
        const meta = { ...(m.metadata || {}), ...confirm };
        if (morphType == null) delete meta.morphType;
        else meta.morphType = morphType;
        m.metadata = meta;
      });
    });
  }
};
