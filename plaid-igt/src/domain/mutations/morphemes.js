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

import { cpSlice, mergeMetadata } from '@larc-iu/plaid-client';
import { isValidMorphType, cliticTypesForChain } from '../affixMarkers.js';
import { isZeroMorph } from '../zeroMorph.js';
import { isVirtualMorphemeId, virtualMorphemeWordId } from '../virtualMorpheme.js';

// A person's edit of a morpheme carries the writer's edit stamp (provenance
// write-contract rule 3): a verifier's edit confirms a machine-made or
// contributed segmentation, a contributor's marks it contributed. Merged into
// the same metadata patch; null-safe for a verifier's own morphemes. A new
// morpheme a person makes carries the create stamp likewise.
const stamped = (doc, morpheme, patch) => ({
  ...patch,
  ...(doc.editStamp(morpheme?.metadata) || {}),
});
const created = (doc, meta) => {
  const stamp = doc.createStamp;
  if (!stamp) return meta;
  return { ...(meta || {}), ...stamp };
};

const morphemesInWord = (morphemeTokens, word) =>
  (morphemeTokens || []).filter((m) => m.begin === word.begin && m.end === word.end);

// Resolve a morpheme id to what it names, for the "couldn't resolve this id"
// guard every morpheme mutation opens with. A real id names a token. A virtual
// one (`derive`'s morpheme for an unanalyzed word) has no token yet, so it
// names the WORD, which `_materializeMorpheme` turns into a token once the
// mutation is committed to writing. Null when neither resolves, or when the
// project has no morpheme layer to write into.
const resolveMorpheme = (doc, morphemeId) => {
  const info = doc.layerInfo;
  if (!info.morphemeTokenLayer?.id || !info.primaryTextLayer?.text?.id) return null;
  if (isVirtualMorphemeId(morphemeId)) {
    const wordId = virtualMorphemeWordId(morphemeId);
    const word = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === wordId);
    return word ? { virtual: true, word } : null;
  }
  const token = (info.morphemeTokenLayer.tokens || []).find((m) => m.id === morphemeId);
  return token ? { virtual: false, token } : null;
};

const sortByPrecedence = (ms) => [...ms].sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));

const formOf = (morpheme, body) => {
  const meta = morpheme?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return cpSlice(body, morpheme.begin, morpheme.end);
};

export const morphemeMutations = {
  // Write one morpheme token onto `word` and patch it into local state, WITHOUT
  // a `_withSaving` wrapper: the callers below are already inside one, and
  // `_materializeMorpheme` runs inside theirs. Returns the new token's id.
  async _writeMorpheme(word, metadata) {
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    const precedence = morphemesInWord(morphemeLayer.tokens, word).length + 1;

    const result = await this._client.tokens.create(
      morphemeLayer.id,
      textId,
      word.begin,
      word.end,
      precedence,
      metadata,
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
        metadata: metadata || {},
      });
    });
    return newId;
  },

  // Turn the morpheme `derive` synthesized for an unanalyzed word (see
  // virtualMorpheme.js) into a real token, and answer with its id. Anything
  // `resolveMorpheme` already found a token for passes straight through, so a
  // mutation can open with this line and stop caring which kind it was given.
  //
  // `metadata` is the state the caller was about to write anyway, so the
  // materializing write and the caller's write are ONE request rather than a
  // create followed by a patch.
  async _materializeMorpheme(resolved, metadata) {
    if (!resolved.virtual) return resolved.token.id;
    // A virtual morpheme is a word nobody has touched, so whatever brings it
    // into being is its creation, stamp and all.
    return this._writeMorpheme(resolved.word, created(this, metadata));
  },

  // Resolve-and-materialize in one call, for the writers OUTSIDE this mixin
  // that take a morpheme id: an annotation span, a vocabulary link. A real id
  // (including a word's, since those writers take either) passes straight
  // through, so a call site can hand over whatever it has. Null when the id
  // resolves to nothing, which the caller reports as it reports any bad id.
  async materializeMorphemeId(morphemeId) {
    if (!isVirtualMorphemeId(morphemeId)) return morphemeId;
    const resolved = resolveMorpheme(this, morphemeId);
    return resolved ? this._materializeMorpheme(resolved, {}) : null;
  },

  // The same for a list of ids, in ONE bulk create rather than a request each:
  // "link every ‹roa› in this text" can name a morpheme for every unanalyzed
  // word reading roa. Answers ids positionally, null where one resolved to
  // nothing. Must run BEFORE any batch the caller opens, since a create's id is
  // only readable outside one.
  async materializeMorphemeIds(morphemeIds) {
    // DISTINCT ids: one word's morpheme can be named several times in one call
    // (a confirm adopting a guess into two fields of the same cell column), and
    // each must resolve to the same single token, not to one token apiece.
    const virtual = [...new Set(morphemeIds.filter(isVirtualMorphemeId))];
    if (!virtual.length) return morphemeIds;

    const info = this.layerInfo;
    const layerId = info.morphemeTokenLayer?.id;
    const textId = info.primaryTextLayer?.text?.id;
    if (!layerId || !textId) return morphemeIds.map((id) => (isVirtualMorphemeId(id) ? null : id));

    const words = new Map((info.primaryTokenLayer?.tokens || []).map((t) => [t.id, t]));
    // Only a word with no morpheme at all gets one here, which is what makes a
    // morpheme virtual, so precedence is always 1 and there are no siblings to
    // renumber.
    const plans = [];
    for (const id of virtual) {
      const word = words.get(virtualMorphemeWordId(id));
      if (word) plans.push({ id, word });
    }
    if (!plans.length) return morphemeIds.map((id) => (isVirtualMorphemeId(id) ? null : id));

    const metadata = created(this, undefined);
    const result = await this._client.tokens.bulkCreate(
      plans.map(({ word }) => ({
        tokenLayerId: layerId,
        text: textId,
        begin: word.begin,
        end: word.end,
        precedence: 1,
        ...(metadata ? { metadata } : {}),
      })),
    );
    const newIds = result?.body?.ids ?? result?.ids ?? [];

    const resolvedById = new Map();
    this._applyRawPatch((next, infoNext) => {
      const layer = infoNext.morphemeTokenLayer;
      if (!layer) return;
      if (!Array.isArray(layer.tokens)) layer.tokens = [];
      plans.forEach(({ id, word }, i) => {
        const newId = newIds[i];
        if (!newId) return;
        resolvedById.set(id, newId);
        layer.tokens.push({
          id: newId,
          text: textId,
          begin: word.begin,
          end: word.end,
          precedence: 1,
          metadata: metadata || {},
        });
      });
    });

    return morphemeIds.map((id) => (isVirtualMorphemeId(id) ? (resolvedById.get(id) ?? null) : id));
  },

  // Append a new morpheme to a word; precedence = (existing count) + 1.
  async createMorpheme(wordTokenId, form) {
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    if (!morphemeLayer?.id || !textId) {
      this.setError('Morpheme layer not configured');
      return false;
    }
    const word = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === wordTokenId);
    if (!word) {
      this.setError(`Word ${wordTokenId} not found`);
      return false;
    }

    return this._withSaving('Failed to create morpheme', async () => {
      await this._writeMorpheme(word, created(this, form ? { form } : undefined));
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
    const word = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === wordTokenId);
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
            created(this, form ? { form } : undefined),
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
            metadata: created(this, form ? { form } : undefined) || {},
          });
        });
      });
    });
  },

  // Split a morpheme's form into two: existing gets `leftForm`, a new one
  // with `rightForm` is inserted at the next precedence; subsequent morphemes
  // shift +1. `joiner` '=' marks the boundary as a clitic boundary (see
  // splitMorphemeMulti).
  async splitMorpheme(morphemeId, leftForm, rightForm, joiner = '-') {
    return this.splitMorphemeMulti(morphemeId, [leftForm, rightForm], { joiners: [joiner] });
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
  // `joiners` (optional, one per boundary, '-' | '=') types the clitic side of
  // each '=' boundary via cliticTypesForChain — positional rule, never
  // overwriting a type the target morpheme already has.
  async splitMorphemeMulti(morphemeId, segments, { joiners = [] } = {}) {
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
    const resolved = resolveMorpheme(this, morphemeId);
    if (!resolved) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }

    return this._withSaving('Failed to split morpheme', async () => {
      // Splitting a word nobody has analyzed writes the morpheme being split
      // before splitting it. Rare in practice (typing the first character of a
      // form materializes it, and a boundary comes after that), so this pays
      // for the paste-a-segmentation-into-a-fresh-word path rather than the
      // keystroke one.
      // Awaited ONLY when there is something to write: an `await` on the
      // common path costs a microtask, and the editor's focus restore runs off
      // this turn, and a split that yielded before rendering left the caret on the
      // morpheme it had just split away from.
      const targetId = resolved.virtual
        ? await this._materializeMorpheme(resolved, {})
        : resolved.token.id;
      const target = (this.layerInfo.morphemeTokenLayer?.tokens || []).find(
        (m) => m.id === targetId,
      );
      if (!target) throw new Error(`Morpheme ${morphemeId} not found`);
      const firstForm = segments[0];
      const restForms = segments.slice(1);
      // Read the token list back off `layerInfo` rather than the `morphemeLayer`
      // captured above: materializing pushed a token into local state, and the
      // captured layer predates it.
      const morphemeTokens = this.layerInfo.morphemeTokenLayer?.tokens || [];
      const siblings = sortByPrecedence(morphemesInWord(morphemeTokens, target));
      const currentPrecedence =
        target.precedence ?? siblings.findIndex((m) => m.id === targetId) + 1;
      const subsequents = siblings.filter((m) => (m.precedence ?? 0) > currentPrecedence);
      const shifted = [...subsequents].sort((a, b) => (b.precedence ?? 0) - (a.precedence ?? 0));
      const types = cliticTypesForChain({
        joiners: segments.slice(1).map((_, i) => joiners[i] ?? '-'),
        startIdx: currentPrecedence - 1,
        count: siblings.length + restForms.length,
        types: [target.metadata?.morphType ?? null, ...restForms.map(() => null)],
      });
      const firstPatch = { form: firstForm };
      if (types[0] != null && target.metadata?.morphType == null) firstPatch.morphType = types[0];
      // Every piece gets an explicit form, an empty one included. A morpheme
      // with no `form` key renders the word's text (that is how a word's single
      // default morpheme shows the word), so a right-edge split ("ngo-" with
      // nothing after the caret yet) used to show the whole word in the new
      // cell, with the caret at its start.
      const restMeta = (form, i) =>
        created(this, {
          form: form ?? '',
          ...(types[i + 1] != null ? { morphType: types[i + 1] } : {}),
        });

      const results = await this._client.batched(async () => {
        // patch, not set: form edits must not clobber other metadata keys
        // (morphType from the FLEx import, in particular)
        this._client.tokens.patchMetadata(targetId, stamped(this, target, firstPatch));
        shifted.forEach((m) => {
          this._client.tokens.update(
            m.id,
            undefined,
            undefined,
            (m.precedence ?? 0) + restForms.length,
          );
        });
        restForms.forEach((form, i) => {
          this._client.tokens.create(
            morphemeLayer.id,
            textId,
            target.begin,
            target.end,
            currentPrecedence + 1 + i,
            restMeta(form, i),
          );
        });
      });
      // setMetadata is 0; shifts are 1..S (S = shifted.length); creates follow.
      const newIds = restForms.map((_, i) => results[shifted.length + 1 + i]?.body?.id);

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer) return;
        const tokens = layer.tokens || [];
        const t = tokens.find((m) => m.id === targetId);
        if (t) {
          t.metadata = mergeMetadata(t.metadata, stamped(this, target, firstPatch));
        }
        tokens.forEach((m) => {
          if (
            m.begin === target.begin &&
            m.end === target.end &&
            (m.precedence ?? 0) > currentPrecedence
          ) {
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
            metadata: restMeta(form, i),
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
    // A virtual morpheme is its word's only one, so there is nothing before it
    // to merge into, the same no-op the first real morpheme of a word gets.
    if (isVirtualMorphemeId(morphemeId)) return false;
    const target = (morphemeLayer?.tokens || []).find((m) => m.id === morphemeId);
    if (!target) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }
    const siblings = sortByPrecedence(morphemesInWord(morphemeLayer.tokens, target));
    const idx = siblings.findIndex((m) => m.id === morphemeId);
    if (idx <= 0) return false;
    const previous = siblings[idx - 1];

    return this._withSaving('Failed to merge morphemes', async () => {
      const body = this.body;
      const previousForm = formOf(previous, body);
      const currentForm = formOf(target, body);
      // A zero morph contributes no surface material, so merging across one
      // drops it rather than gluing the character on: Backspace at the start of
      // a cell after `dog` + `∅` gives `dog`, not `dog∅`. Merging two zeros
      // leaves one.
      const mergedForm = isZeroMorph(previousForm)
        ? currentForm
        : isZeroMorph(currentForm)
          ? previousForm
          : previousForm + currentForm;
      const subsequents = siblings.slice(idx + 1);

      await this._client.batched(async () => {
        this._client.tokens.patchMetadata(
          previous.id,
          stamped(this, previous, { form: mergedForm }),
        );
        this._client.tokens.delete(morphemeId);
        subsequents.forEach((m) => {
          this._client.tokens.update(m.id, undefined, undefined, (m.precedence ?? 0) - 1);
        });
      });

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer || !Array.isArray(layer.tokens)) return;
        const prev = layer.tokens.find((m) => m.id === previous.id);
        if (prev)
          prev.metadata = mergeMetadata(
            prev.metadata,
            stamped(this, previous, { form: mergedForm }),
          );
        layer.tokens = layer.tokens.filter((m) => m.id !== morphemeId);
        layer.tokens.forEach((m) => {
          if (
            m.begin === target.begin &&
            m.end === target.end &&
            (m.precedence ?? 0) > (target.precedence ?? 0)
          ) {
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
    // A virtual morpheme is its word's last one, and it holds nothing to throw
    // away, the same refusal a sole real morpheme gets, for the same reason.
    if (isVirtualMorphemeId(morphemeId)) {
      this.setError('Cannot delete the last morpheme of a word');
      return false;
    }
    const target = (morphemeLayer?.tokens || []).find((m) => m.id === morphemeId);
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
      const subsequents = siblings.filter((m) => (m.precedence ?? 0) > (target.precedence ?? 0));

      await this._client.batched(async () => {
        this._client.tokens.delete(morphemeId);
        subsequents.forEach((m) => {
          this._client.tokens.update(m.id, undefined, undefined, (m.precedence ?? 0) - 1);
        });
      });

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer || !Array.isArray(layer.tokens)) return;
        layer.tokens = layer.tokens.filter((m) => m.id !== morphemeId);
        layer.tokens.forEach((m) => {
          if (
            m.begin === target.begin &&
            m.end === target.end &&
            (m.precedence ?? 0) > (target.precedence ?? 0)
          ) {
            m.precedence = (m.precedence ?? 0) - 1;
          }
        });
      });
    });
  },

  // Update a morpheme's form (single metadata patch — other keys survive).
  // Typing into an unanalyzed word's cell arrives here, and the morpheme it
  // names is created carrying the typed form: one write, not a create and a
  // patch.
  async updateMorphemeForm(morphemeId, form) {
    const resolved = resolveMorpheme(this, morphemeId);
    if (!resolved) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }

    return this._withSaving('Failed to update morpheme form', async () => {
      if (resolved.virtual) {
        await this._materializeMorpheme(resolved, { form });
        return;
      }
      const target = resolved.token;
      const patch = stamped(this, target, { form });
      await this._client.tokens.patchMetadata(target.id, patch);

      this._applyRawPatch((next, infoNext) => {
        const m = (infoNext.morphemeTokenLayer?.tokens || []).find((x) => x.id === target.id);
        if (m) m.metadata = mergeMetadata(m.metadata, patch);
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
    const resolved = resolveMorpheme(this, morphemeId);
    if (!resolved) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }

    return this._withSaving('Failed to set morpheme type', async () => {
      if (resolved.virtual) {
        // Clearing the type of a morpheme that has none asks for nothing, so
        // it stays virtual rather than being written into existence empty.
        if (morphType == null) return;
        await this._materializeMorpheme(resolved, { morphType });
        return;
      }
      const target = resolved.token;
      // patch semantics: a null value deletes the key
      const confirm = this.editStamp(target.metadata) || {};
      await this._client.tokens.patchMetadata(target.id, {
        morphType: morphType ?? null,
        ...confirm,
      });

      this._applyRawPatch((next, infoNext) => {
        const m = (infoNext.morphemeTokenLayer?.tokens || []).find((x) => x.id === target.id);
        if (!m) return;
        const meta = mergeMetadata(m.metadata, confirm);
        if (morphType == null) delete meta.morphType;
        else meta.morphType = morphType;
        m.metadata = meta;
      });
    });
  },
};
