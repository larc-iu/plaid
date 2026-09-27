// Mutation mixin: morpheme operations. See IgtDocument.js for the `this`
// API (_queueWrite, _applyRawPatch, _reload, layerInfo, body, etc.).
//
// IGT morpheme model: morphemes share their parent word's begin/end (no
// sub-range; MWTs are multiple morphemes at the same extent). Order within
// the word is 1-based contiguous `precedence`. Insert/remove/reorder must
// renumber so precedence stays gap-free.
//
// Guard convention (matches the rest of src/domain/mutations): "couldn't
// resolve this id" / "no-op condition" guards do `setError + return false`
// outside `_queueWrite` so we don't trigger a needless `_reload` for an
// invalid input. `throw` inside `_queueWrite` is reserved for unexpected
// failure paths the server is reporting.

import { cpSlice, mergeMetadata, metadataOps, createdId } from '@larc-iu/plaid-client';
import { isValidMorphType, cliticTypesForChain } from '../affixMarkers.js';
import { isZeroMorph } from '../zeroMorph.js';
import { pendingId, settledId } from '@ui/domain/pendingIds.js';
import {
  isVirtualMorphemeId,
  virtualMorphemeId,
  virtualMorphemeWordId,
} from '../virtualMorpheme.js';
import { notSetUp } from '../setupGuard.js';

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
// names the WORD, whose morpheme the mutation makes along with its edit; one
// an earlier edit has made already names that token. Null when neither
// resolves, or when the project has no morpheme layer to write into.
const resolveMorpheme = (doc, morphemeId) => {
  const info = doc.layerInfo;
  if (!info.morphemeTokenLayer?.id || !info.primaryTextLayer?.text?.id) return null;
  const id = doc._currentMorphemeId(morphemeId);
  if (id) {
    const token = (info.morphemeTokenLayer.tokens || []).find((m) => m.id === id);
    return token ? { virtual: false, token } : null;
  }
  if (!isVirtualMorphemeId(morphemeId)) return null;
  const wordId = settledId(virtualMorphemeWordId(morphemeId));
  const word = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === wordId);
  return word ? { virtual: true, word } : null;
};

const sortByPrecedence = (ms) => [...ms].sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));

const formOf = (morpheme, body) => {
  const meta = morpheme?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return cpSlice(body, morpheme.begin, morpheme.end);
};

export const morphemeMutations = {
  // Turn virtual morpheme ids into real tokens on the server, in one bulk
  // create, and answer the ids positionally (null where one resolved to
  // nothing). For the bulk analysis copy, which runs entirely inside its send
  // and reloads at the end; every interactive edit plans its morpheme with
  // `_planMorphemes` instead, so it shows before the server answers.
  async materializeMorphemeIds(morphemeIds) {
    const { ids, creates } = this._planMorphemes(morphemeIds);
    if (!creates.length) return ids;
    const made = new Map();
    await this._sendMorphemes(creates, made);
    this._applyRawPatch((next, infoNext) => {
      this._showMorphemes(
        infoNext,
        creates.filter((c) => made.get(c.id)).map((c) => ({ ...c, id: made.get(c.id) })),
      );
    });
    return ids.map((id) => (made.has(id) ? made.get(id) : id));
  },

  // Append a new morpheme to a word; precedence = (existing count) + 1.
  async createMorpheme(wordTokenId, form) {
    return this.createMorphemes(wordTokenId, [form]);
  },

  // Append N morphemes to a word, in one batch. Used by the MWT-split flow
  // where a single form is split into several at once. Precedences are
  // assigned starting from (existing count) + 1 in order.
  async createMorphemes(wordTokenId, forms) {
    if (!Array.isArray(forms) || forms.length === 0) return false;
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    if (!morphemeLayer?.id || !textId) {
      this.setError(notSetUp('Morpheme layer not configured'));
      return false;
    }
    const word = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === wordTokenId);
    if (!word) {
      this.setError(`Word ${wordTokenId} not found`);
      return false;
    }
    const label = forms.length === 1 ? 'Failed to create morpheme' : 'Failed to create morphemes';
    if (!this._canWrite(label)) return false;
    const base = morphemesInWord(morphemeLayer.tokens, word).length + 1;
    const rows = forms.map((form, i) => ({
      id: pendingId(),
      begin: word.begin,
      end: word.end,
      precedence: base + i,
      metadata: created(this, form ? { form } : undefined) || {},
    }));
    this._applyRawPatch((next, infoNext) => this._showMorphemes(infoNext, rows));
    return this._queueWrite(label, async () => {
      const ids = new Map();
      const results = await this._client.batched(async (b) => {
        rows.forEach((r) =>
          b.tokens.create(
            morphemeLayer.id,
            textId,
            r.begin,
            r.end,
            r.precedence,
            Object.keys(r.metadata).length ? r.metadata : undefined,
          ),
        );
      });
      rows.forEach((r, i) => ids.set(r.id, createdId(results[i])));
      this._settle(ids);
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
  // `segments`: the existing morpheme keeps segments[0] as its form (and its
  // annotations/links), segments[1..] are inserted after it; subsequent
  // morphemes shift by segments.length - 1. The new cells show at once.
  //
  // Batch order: the target's metadata, then shift subsequents in descending
  // precedence to free the target slots, then create at the freed slots. The
  // creates MUST run AFTER the shifts: if a new (begin, end, precedence)
  // triple collides with an existing morpheme's it's a server-side 409.
  // `joiners` (optional, one per boundary, '-' | '=') types the clitic side of
  // each '=' boundary via cliticTypesForChain: positional rule, never
  // overwriting a type the target morpheme already has.
  async splitMorphemeMulti(morphemeId, segments, { joiners = [] } = {}) {
    if (!Array.isArray(segments) || segments.length < 2) {
      console.error('splitMorphemeMulti needs at least two segments', segments);
      this.setError('Could not split the morpheme.');
      return false;
    }
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    if (!morphemeLayer?.id || !textId) {
      this.setError(notSetUp('Morpheme layer not configured'));
      return false;
    }
    const resolved = resolveMorpheme(this, morphemeId);
    if (!resolved) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }
    const label = 'Failed to split morpheme';
    if (!this._canWrite(label)) return false;

    // Splitting a word nobody has analyzed makes the morpheme being split,
    // carrying its first piece, in the same send.
    const target = resolved.virtual
      ? {
          id: pendingId(),
          begin: resolved.word.begin,
          end: resolved.word.end,
          precedence: 1,
          metadata: {},
        }
      : resolved.token;
    const firstForm = segments[0];
    const restForms = segments.slice(1);
    const siblings = resolved.virtual
      ? [target]
      : sortByPrecedence(morphemesInWord(morphemeLayer.tokens, target));
    const currentPrecedence =
      target.precedence ?? siblings.findIndex((m) => m.id === target.id) + 1;
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
    const firstMeta = resolved.virtual
      ? created(this, firstPatch)
      : stamped(this, target, firstPatch);
    // Every piece gets an explicit form, an empty one included. A morpheme
    // with no `form` key renders the word's text (that is how a word's single
    // default morpheme shows the word), so a right-edge split ("ngo-" with
    // nothing after the caret yet) used to show the whole word in the new
    // cell, with the caret at its start.
    const rest = restForms.map((form, i) => ({
      id: pendingId(),
      begin: target.begin,
      end: target.end,
      precedence: currentPrecedence + 1 + i,
      metadata: created(this, {
        form: form ?? '',
        ...(types[i + 1] != null ? { morphType: types[i + 1] } : {}),
      }),
    }));

    this._applyRawPatch((next, infoNext) => {
      const layer = infoNext.morphemeTokenLayer;
      if (!layer) return;
      if (!Array.isArray(layer.tokens)) layer.tokens = [];
      if (resolved.virtual) {
        layer.tokens.push({ ...target, text: textId, metadata: firstMeta });
      } else {
        const t = layer.tokens.find((m) => m.id === target.id);
        if (t) t.metadata = mergeMetadata(t.metadata, firstMeta);
        layer.tokens.forEach((m) => {
          if (
            m.begin === target.begin &&
            m.end === target.end &&
            (m.precedence ?? 0) > currentPrecedence
          ) {
            m.precedence = (m.precedence ?? 0) + restForms.length;
          }
        });
      }
      rest.forEach((r) => layer.tokens.push({ ...r, text: textId }));
    });

    return this._queueWrite(label, async () => {
      const ids = new Map();
      if (resolved.virtual) {
        await this._sendMorphemes([{ ...target, metadata: firstMeta }], ids);
      }
      const results = await this._client.batched(async (b) => {
        // patch, not set: form edits must not clobber other metadata keys
        // (morphType from the FLEx import, in particular)
        if (!resolved.virtual) {
          b.tokens.patchMetadata(settledId(target.id), metadataOps(firstMeta));
        }
        shifted.forEach((m) => {
          b.tokens.update(
            settledId(m.id),
            undefined,
            undefined,
            (m.precedence ?? 0) + restForms.length,
          );
        });
        rest.forEach((r) => {
          b.tokens.create(morphemeLayer.id, textId, r.begin, r.end, r.precedence, r.metadata);
        });
      });
      // The target's patch (a real one only), the shifts, then the creates.
      const offset = (resolved.virtual ? 0 : 1) + shifted.length;
      rest.forEach((r, i) => ids.set(r.id, createdId(results[offset + i])));
      this._settle(ids);
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
    const label = 'Failed to merge morphemes';
    if (!this._canWrite(label)) return false;

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
    const patch = stamped(this, previous, { form: mergedForm });

    this._applyRawPatch((next, infoNext) => {
      const layer = infoNext.morphemeTokenLayer;
      if (!layer || !Array.isArray(layer.tokens)) return;
      const prev = layer.tokens.find((m) => m.id === previous.id);
      if (prev) prev.metadata = mergeMetadata(prev.metadata, patch);
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

    return this._queueWrite(label, () =>
      this._client.batched(async (b) => {
        b.tokens.patchMetadata(settledId(previous.id), metadataOps(patch));
        b.tokens.delete(settledId(morphemeId));
        subsequents.forEach((m) => {
          b.tokens.update(settledId(m.id), undefined, undefined, (m.precedence ?? 0) - 1);
        });
      }),
    );
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
    const label = 'Failed to delete morpheme';
    if (!this._canWrite(label)) return false;
    const subsequents = siblings.filter((m) => (m.precedence ?? 0) > (target.precedence ?? 0));

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
      // The server's cascade takes what hangs off the token.
      Object.values(infoNext.spanLayers?.morpheme || []).forEach((sl) => {
        if (Array.isArray(sl.spans)) {
          sl.spans = sl.spans.filter((s) => !(s.tokens || []).includes(morphemeId));
        }
      });
    });

    return this._queueWrite(label, () =>
      this._client.batched(async (b) => {
        b.tokens.delete(settledId(morphemeId));
        subsequents.forEach((m) => {
          b.tokens.update(settledId(m.id), undefined, undefined, (m.precedence ?? 0) - 1);
        });
      }),
    );
  },

  // Update a morpheme's form (single metadata patch; other keys survive).
  // Typing into an unanalyzed word's cell arrives here, and the morpheme it
  // names is created carrying the typed form: one write, not a create and a
  // patch.
  async updateMorphemeForm(morphemeId, form) {
    const resolved = resolveMorpheme(this, morphemeId);
    if (!resolved) {
      this.setError(`Morpheme ${morphemeId} not found`);
      return false;
    }
    return this._writeMorphemeMeta(resolved, 'Failed to update morpheme form', (target) => ({
      patch: stamped(this, target, { form }),
      created: { form },
    }));
  },

  // Set or clear (null) a morpheme's type: metadata.morphType, constrained
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
    // Clearing the type of a morpheme that has none asks for nothing, so it
    // stays virtual rather than being written into existence empty.
    if (resolved.virtual && morphType == null) return true;
    return this._writeMorphemeMeta(resolved, 'Failed to set morpheme type', (target) => ({
      // A cleared type is a delete op.
      patch: { morphType: morphType ?? null, ...(this.editStamp(target?.metadata) || {}) },
      created: { morphType },
    }));
  },

  // One metadata change to one morpheme, shown at once: a patch of a real
  // token, or the creation of an unanalyzed word's morpheme carrying it.
  // `change(target)` answers `{ patch, created }`, the patch for a real token
  // (a null value deletes its key) and the metadata a new one is made with.
  _writeMorphemeMeta(resolved, label, change) {
    if (!this._canWrite(label)) return false;
    if (resolved.virtual) {
      const { creates } = this._planMorphemes(
        [virtualMorphemeId(resolved.word.id)],
        () => change(null).created,
      );
      this._applyRawPatch((next, infoNext) => this._showMorphemes(infoNext, creates));
      return this._queueWrite(label, async () => {
        const ids = new Map();
        await this._sendMorphemes(creates, ids);
        this._settle(ids);
      });
    }
    const target = resolved.token;
    const { patch } = change(target);
    this._applyRawPatch((next, infoNext) => {
      const m = (infoNext.morphemeTokenLayer?.tokens || []).find((x) => x.id === target.id);
      if (m) m.metadata = mergeMetadata(m.metadata, patch);
    });
    return this._queueWrite(label, () =>
      this._client.tokens.patchMetadata(settledId(target.id), metadataOps(patch)),
    );
  },
};
