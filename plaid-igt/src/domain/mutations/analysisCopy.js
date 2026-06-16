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

// The server caps a single atomic batch at 1000 ops (plaid-core
// rest_api/v1/batch.clj). A copy emits several ops per word, so pack words into
// chunks whose batch-1 estimate stays comfortably under the cap.
const ANALYSIS_BATCH_BUDGET = 800;

// Worst-case batch-1 op count for one word's copy: the default-morpheme patch,
// a create per extra morpheme, and a link + fields for every slot and the word.
const opsForWord = (p) => {
  const a = p.analysis || {};
  const slots = a.morphemes || [];
  let n = 1; // token patch for the default morpheme
  for (const s of slots) n += 1 + Object.keys(s.fields || {}).length; // link + fields per slot
  n += Math.max(0, slots.length - 1); // one create per extra morpheme
  n += 1 + Object.keys(a.word?.fields || {}).length; // word link + fields
  return n;
};

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

    // A large unanalyzed document can emit far more than one batch's worth of
    // ops (this runs unattended from the auto-analysis pass). Pack words into
    // chunks under the server cap; each chunk runs its own batch-1 + batch-2
    // atomically. Partial progress across chunks is fine — a copied word is no
    // longer unanalyzed, so it won't be silently re-targeted — and it keeps a
    // too-big copy from failing forever and re-triggering the pass on reload.
    const chunks = [];
    let cur = [];
    let curOps = 0;
    for (const p of todo) {
      const w = opsForWord(p);
      if (cur.length && curOps + w > ANALYSIS_BATCH_BUDGET) { chunks.push(cur); cur = []; curOps = 0; }
      cur.push(p);
      curOps += w;
    }
    if (cur.length) chunks.push(cur);

    return (await this._withSaving('Failed to copy previous analyses', async () => {
      for (const chunk of chunks) {
        // ---- batch 1: structure + everything addressable now ----
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

        const results = await this._client.batched(async () => {
          for (const p of chunk) {
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
        });

        // ---- batch 2: links/spans for the created morphemes ----
        const second = pendingMorphs
          .map(({ slot, opIdx: i }) => ({ slot, id: results[i]?.body?.id }))
          .filter(({ slot, id }) => id && (slot.vocabItemId || Object.keys(slot.fields || {}).length));
        if (second.length) {
          await this._client.batched(async () => {
            for (const { slot, id } of second) {
              const item = findVocabItem(this._vocabularies, slot.vocabItemId);
              if (item) this._client.vocabLinks.create(item.id, [id], stamp);
              for (const [name, value] of Object.entries(slot.fields || {})) {
                const layer = morphLayersByName.get(name);
                if (!layer) continue;
                this._client.spans.create(layer.id, [id], value, stamp);
              }
            }
          });
        }
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
      await this._client.withAuditMessage('Confirm word analysis', async () => {
        await this._client.batched(async () => {
          tokenIds.forEach((id) => this._client.tokens.patchMetadata(id, confirm));
          linkIds.forEach((id) => this._client.vocabLinks.patchMetadata(id, confirm));
          spanIds.forEach((id) => this._client.spans.patchMetadata(id, confirm));
        });
      });

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
