// Mutation mixin: whole-word analysis copies (see domain/analysisMemory.js).
// Applies [{ wordTokenId, analysis }] proposals: the word's single default
// morpheme becomes the analysis's first slot, further slots are created, and
// vocab links + annotation spans are written for every slot — all stamped
// { prov: 'inferred', provSource } so they render as unverified.
//
// Two batches, because created morphemes' ids are needed before their links
// and spans can be written: batch 1 does all structure (morpheme patches +
// creates) plus everything addressable now (word-level links/spans, first-slot
// links/spans); batch 2 does links/spans for the newly created morphemes.
// A batch-2 failure can therefore leave a word with copied segmentation but
// missing links/glosses — _withSaving surfaces it loudly and the word, no
// longer unanalyzed, won't be silently re-targeted.
//
// Ends with one _reload() instead of optimistic patches: a copy touches up to
// four entity families per word, and the auto-pass that drives this runs
// outside any focused-cell interaction, so a full resync is the simple,
// correct move (same as the service-backed auto-link path).

import { stampInferred, provState, PROV, PROV_STATES } from '@larc-iu/plaid-client';
import { isUnanalyzedWord } from '../analysisMemory.js';

const findVocabItem = (vocabularies, vocabItemId) => {
  if (!vocabItemId) return null;
  for (const vocab of Object.values(vocabularies || {})) {
    const item = (vocab.items || []).find((i) => i.id === vocabItemId);
    if (item) return item;
  }
  return null;
};

export const analysisCopyMutations = {
  // Returns the number of words a copy was applied to (false on failure).
  async bulkApplyAnalyses(proposals, provSource) {
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    if (!morphemeLayer?.id || !textId) {
      this.setError('Morpheme layer not configured');
      return false;
    }
    const wordLayersByName = new Map((info.spanLayers?.word || []).map((l) => [l.name, l]));
    const morphLayersByName = new Map((info.spanLayers?.morpheme || []).map((l) => [l.name, l]));

    // Revalidate against the CURRENT derived state — proposals may be stale
    // (computed before an edit landed). Only still-unanalyzed words proceed.
    const todo = [];
    for (const p of proposals || []) {
      const token = this.tokenLookup.get(p.wordTokenId);
      if (!token || !isUnanalyzedWord(token)) continue;
      if (!(token.morphemes?.length === 1)) continue;
      todo.push({ ...p, token, m0: token.morphemes[0] });
    }
    if (!todo.length) return 0;

    const stamp = stampInferred(provSource);

    return (await this._withSaving('Failed to copy previous analyses', async () => {
      // ---- batch 1: structure + everything addressable now ----
      this._client.beginBatch();
      let opIdx = 0;
      const pendingMorphs = []; // { slot, opIdx } — created morphemes needing batch-2 links/spans
      const queueLinkAndSpans = (tokenId, slot) => {
        const item = findVocabItem(this._vocabularies, slot.vocabItemId);
        if (item) {
          this._client.vocabLinks.create(item.id, [tokenId], stamp);
          opIdx++;
        }
        for (const [name, value] of Object.entries(slot.fields || {})) {
          const layer = morphLayersByName.get(name);
          if (!layer) continue;
          this._client.spans.create(layer.id, [tokenId], value, stamp);
          opIdx++;
        }
      };

      for (const p of todo) {
        const { token, m0, analysis } = p;
        const slots = analysis.morphemes || [];
        const s0 = slots[0] || null;

        // First slot reuses the existing default morpheme. Only stamp the
        // token when the copy actually changes its segmentation-tier data
        // (form/morphType) — links/spans carry their own provenance.
        if (s0) {
          const patch = {};
          if (s0.form != null && s0.form !== token.content) patch.form = s0.form;
          if (s0.morphType != null) patch.morphType = s0.morphType;
          if (Object.keys(patch).length || slots.length > 1) {
            this._client.tokens.patchMetadata(m0.id, { ...patch, ...stamp });
            opIdx++;
          }
          queueLinkAndSpans(m0.id, s0);
        }
        // Remaining slots: create stamped morpheme tokens; their links/spans
        // wait for batch 2 (ids unknown until this batch lands).
        slots.slice(1).forEach((slot, j) => {
          this._client.tokens.create(
            morphemeLayer.id, textId, token.begin, token.end, j + 2,
            {
              ...(slot.form != null ? { form: slot.form } : {}),
              ...(slot.morphType != null ? { morphType: slot.morphType } : {}),
              ...stamp,
            }
          );
          pendingMorphs.push({ slot, opIdx });
          opIdx++;
        });
        // Word-level link + fields.
        const wordItem = findVocabItem(this._vocabularies, analysis.word?.vocabItemId);
        if (wordItem) {
          this._client.vocabLinks.create(wordItem.id, [token.id], stamp);
          opIdx++;
        }
        for (const [name, value] of Object.entries(analysis.word?.fields || {})) {
          const layer = wordLayersByName.get(name);
          if (!layer) continue;
          this._client.spans.create(layer.id, [token.id], value, stamp);
          opIdx++;
        }
      }
      const results = await this._client.submitBatch();

      // ---- batch 2: links/spans for the created morphemes ----
      const second = pendingMorphs
        .map(({ slot, opIdx: i }) => ({ slot, id: results[i]?.body?.id }))
        .filter(({ slot, id }) => id && (slot.vocabItemId || Object.keys(slot.fields || {}).length));
      if (second.length) {
        this._client.beginBatch();
        for (const { slot, id } of second) {
          const item = findVocabItem(this._vocabularies, slot.vocabItemId);
          if (item) this._client.vocabLinks.create(item.id, [id], stamp);
          for (const [name, value] of Object.entries(slot.fields || {})) {
            const layer = morphLayersByName.get(name);
            if (!layer) continue;
            this._client.spans.create(layer.id, [id], value, stamp);
          }
        }
        await this._client.submitBatch();
      }

      await this._reload();
    })) ? todo.length : false;
  },

  // Confirm every machine-unverified piece of one word's analysis at once —
  // the deliberate "this whole word looks right" gesture (Ctrl/Cmd+Enter in
  // the editor): the word's link + spans, and each morpheme's token metadata
  // (segmentation), link, and spans. No-op (true) when nothing is unverified.
  async confirmWordAnalysis(wordTokenId) {
    const token = this.tokenLookup.get(wordTokenId);
    if (!token) {
      this.setError(`Word ${wordTokenId} not found`);
      return false;
    }
    const confirm = { [PROV.confirmedKey]: true };
    const spanIds = [];
    const tokenIds = [];
    const linkIds = [];

    const collect = (t, isMorph) => {
      if (t.vocabItem?.prov === PROV_STATES.MACHINE) linkIds.push(t.vocabItem.linkId);
      for (const span of Object.values(t.annotations || {})) {
        if (span && provState(span.metadata) === PROV_STATES.MACHINE) spanIds.push(span.id);
      }
      if (isMorph && provState(t.metadata) === PROV_STATES.MACHINE) tokenIds.push(t.id);
    };
    collect(token, false);
    for (const m of token.morphemes || []) collect(m, true);

    if (!spanIds.length && !tokenIds.length && !linkIds.length) return true;

    return this._withSaving('Failed to confirm analysis', async () => {
      this._client.beginBatch();
      tokenIds.forEach((id) => this._client.tokens.patchMetadata(id, confirm));
      linkIds.forEach((id) => this._client.vocabLinks.patchMetadata(id, confirm));
      spanIds.forEach((id) => this._client.spans.patchMetadata(id, confirm));
      await this._client.submitBatch();

      const spanSet = new Set(spanIds);
      const tokenSet = new Set(tokenIds);
      const linkSet = new Set(linkIds);
      this._applyRawPatch((next, infoNext, vocabs) => {
        (infoNext.morphemeTokenLayer?.tokens || []).forEach((t) => {
          if (tokenSet.has(t.id)) t.metadata = { ...(t.metadata || {}), ...confirm };
        });
        for (const scope of ['word', 'morpheme']) {
          (infoNext.spanLayers?.[scope] || []).forEach((sl) => {
            (sl.spans || []).forEach((s) => {
              if (spanSet.has(s.id)) s.metadata = { ...(s.metadata || {}), ...confirm };
            });
          });
        }
        Object.values(vocabs || {}).forEach((vocab) => {
          (vocab.vocabLinks || []).forEach((l) => {
            if (linkSet.has(l.id)) l.metadata = { ...(l.metadata || {}), ...confirm };
          });
        });
      });
    });
  },
};
