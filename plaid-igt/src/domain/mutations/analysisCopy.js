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

import { stampInferred, isMachine, PROV, PROV_CONFIRMED, PROV_STATES } from '@larc-iu/plaid-client';
import { isUnanalyzedWord, extractAnalysis, analysisSignature } from '../analysisMemory.js';

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

// Ops per atomic batch when stripping analyses (bulkReplaceAnalyses); each
// word emits a handful, so this stays well under the server's 1000-op cap.
const STRIP_CHUNK = 250;

export const analysisCopyMutations = {
  // Returns the number of words a copy was applied to (false on failure).
  async bulkApplyAnalyses(proposals, provSource) {
    const todo = this._planAnalysisApply(proposals);
    if (todo === false) return false;
    if (!todo.length) return 0;
    const ok = await this._withSaving('Failed to copy previous analyses', () =>
      this._applyAnalysesImpl(todo, stampInferred(provSource)),
    );
    return ok ? todo.length : false;
  },

  // Bulk Edit's "re-analyze every occurrence": REPLACE each target word's
  // analysis with `analysis` (same shape as extractAnalysis), whatever it
  // carries now. Two phases under one operation: strip every link, span and
  // extra morpheme off the word (first morpheme reset to the healed default),
  // resync, then run the same apply path as a copy. A human chose this
  // analysis deliberately, so nothing is provenance-stamped: it lands as
  // human work, not as an unverified guess. Words already carrying exactly
  // the target analysis are skipped. Returns the number of words changed
  // (false on failure).
  async bulkReplaceAnalyses(proposals) {
    const targetSig = new Map();
    const targets = [];
    for (const p of proposals || []) {
      const token = this.tokenLookup.get(p.wordTokenId);
      if (!token || !p.analysis) continue;
      let sig = targetSig.get(p.analysis);
      if (!sig) targetSig.set(p.analysis, (sig = analysisSignature(p.analysis)));
      const current = extractAnalysis(token);
      if (current && analysisSignature(current) === sig) continue;
      targets.push({ wordTokenId: p.wordTokenId, analysis: p.analysis, token });
    }
    if (!targets.length) return 0;

    return (await this._withSaving('Failed to re-analyze words', async () => {
      // ---- phase 1: strip. Deleting a morpheme cascades its own spans and
      // links server-side, so only the word's and the surviving first
      // morpheme's are queued explicitly (a double delete fails the batch).
      const strip = []; // thunks, one op each
      for (const { token } of targets) {
        const queueAttached = (t) => {
          if (t.vocabItem?.linkId)
            strip.push(() => this._client.vocabLinks.delete(t.vocabItem.linkId));
          for (const span of Object.values(t.annotations || {})) {
            if (span?.id) strip.push(() => this._client.spans.delete(span.id));
          }
        };
        queueAttached(token);
        const morphs = [...(token.morphemes || [])].sort(
          (a, b) => (a.precedence ?? 0) - (b.precedence ?? 0),
        );
        morphs.forEach((m, i) => {
          if (i > 0) {
            strip.push(() => this._client.tokens.delete(m.id));
            return;
          }
          queueAttached(m);
          // patch semantics: null deletes the key
          strip.push(() =>
            this._client.tokens.patchMetadata(m.id, {
              form: null,
              morphType: null,
              prov: null,
              provSource: null,
              provDetail: null,
              provProb: null,
              provConfirmed: null,
            }),
          );
          // The apply path numbers created morphemes from 2, so the survivor
          // must sit at 1.
          if ((m.precedence ?? 1) !== 1)
            strip.push(() => this._client.tokens.update(m.id, undefined, undefined, 1));
        });
      }
      for (let i = 0; i < strip.length; i += STRIP_CHUNK) {
        const part = strip.slice(i, i + STRIP_CHUNK);
        await this._client.batched(async () => {
          part.forEach((op) => op());
        });
      }
      await this._reload();

      // ---- phase 2: apply, exactly as a copy would (the words are now
      // unanalyzed single-morpheme words). No provenance stamp: human work.
      const todo = this._planAnalysisApply(
        targets.map(({ wordTokenId, analysis }) => ({ wordTokenId, analysis })),
      );
      if (todo === false) throw new Error('Morpheme layer not configured');
      await this._applyAnalysesImpl(todo, {});
    }))
      ? targets.length
      : false;
  },

  // Revalidate copy proposals against the CURRENT derived state — proposals
  // may be stale (computed before an edit landed). Only still-unanalyzed
  // single-morpheme words proceed. Returns the todo list, or false (with the
  // error set) when the document has no morpheme layer to write into.
  _planAnalysisApply(proposals) {
    const info = this.layerInfo;
    if (!info.morphemeTokenLayer?.id || !info.primaryTextLayer?.text?.id) {
      this.setError('Morpheme layer not configured');
      return false;
    }
    const todo = [];
    for (const p of proposals || []) {
      const token = this.tokenLookup.get(p.wordTokenId);
      if (!token || !isUnanalyzedWord(token)) continue;
      if (!(token.morphemes?.length === 1)) continue;
      todo.push({ ...p, token, m0: token.morphemes[0] });
    }
    return todo;
  },

  // The write half of a copy: batch-1/batch-2 per chunk (see the file
  // comment), then one reload. Runs INSIDE a caller's _withSaving. `stamp`
  // is the metadata merged into every created/patched piece ({} for none).
  async _applyAnalysesImpl(todo, stamp) {
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    const wordLayersByName = new Map((info.spanLayers?.word || []).map((l) => [l.name, l]));
    const morphLayersByName = new Map((info.spanLayers?.morpheme || []).map((l) => [l.name, l]));

    // Prediction extras (provenance convention): when the pieces are machine-
    // stamped, each copied span also records the value it was given as
    // provDetail.value and each copied morpheme its segment as provDetail.form.
    // The entity may be edited later; that copy is what tells an accepted-as-is
    // copy from a corrected one once it is verified. A human replace (empty
    // stamp) records nothing. Links need nothing: the item id is the guess.
    const machine = !!stamp?.[PROV.key];
    const withDetail = (detail) => (machine ? { ...stamp, [PROV.detailKey]: detail } : stamp);
    const stampValue = (value) => withDetail({ value });
    const stampForm = (form) => (form == null ? stamp : withDetail({ form }));

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
      if (cur.length && curOps + w > ANALYSIS_BATCH_BUDGET) {
        chunks.push(cur);
        cur = [];
        curOps = 0;
      }
      cur.push(p);
      curOps += w;
    }
    if (cur.length) chunks.push(cur);

    {
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
            this._client.spans.create(layer.id, [tokenId], value, stampValue(value));
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
              const merged = { ...patch, ...stampForm(s0.form) };
              if (Object.keys(merged).length && (Object.keys(patch).length || slots.length > 1)) {
                this._client.tokens.patchMetadata(m0.id, merged);
                opIdx++;
              }
              queueLinkAndSpans(m0.id, s0);
            }
            // Remaining slots: create stamped morpheme tokens; their links/spans
            // wait for batch 2 (ids unknown until this batch lands).
            slots.slice(1).forEach((slot, j) => {
              this._client.tokens.create(morphemeLayer.id, textId, token.begin, token.end, j + 2, {
                ...(slot.form != null ? { form: slot.form } : {}),
                ...(slot.morphType != null ? { morphType: slot.morphType } : {}),
                ...stampForm(slot.form),
              });
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
              this._client.spans.create(layer.id, [token.id], value, stampValue(value));
              opIdx++;
            }
          }
        });

        // ---- batch 2: links/spans for the created morphemes ----
        const second = pendingMorphs
          .map(({ slot, opIdx: i }) => ({ slot, id: results[i]?.body?.id }))
          .filter(
            ({ slot, id }) => id && (slot.vocabItemId || Object.keys(slot.fields || {}).length),
          );
        if (second.length) {
          await this._client.batched(async () => {
            for (const { slot, id } of second) {
              const item = findVocabItem(this._vocabularies, slot.vocabItemId);
              if (item) this._client.vocabLinks.create(item.id, [id], stamp);
              for (const [name, value] of Object.entries(slot.fields || {})) {
                const layer = morphLayersByName.get(name);
                if (!layer) continue;
                this._client.spans.create(layer.id, [id], value, stampValue(value));
              }
            }
          });
        }
      }

      await this._reload();
    }
  },

  // Discard every machine-unverified piece of one word's analysis at once —
  // the mirror of confirmWordAnalysis for a proposal that is wrong wholesale
  // (Ctrl/Cmd+Backspace in the editor). Machine links and spans on the word
  // and its surviving morphemes are deleted; machine morphemes after the
  // first are deleted outright (their spans/links cascade server-side, so
  // they are NOT queued separately — a double delete would fail the batch);
  // a machine first morpheme is reset to the healed default state (form,
  // morphType and prov keys dropped). Human and verified pieces are left
  // alone, so a mixed word keeps its human parts; survivors are renumbered so
  // precedence stays gap-free. Ends with a reload (several entity families
  // change at once). No-op (true) when nothing is unverified.
  async discardWordAnalysis(wordTokenId) {
    const token = this.tokenLookup.get(wordTokenId);
    if (!token) {
      this.setError(`Word ${wordTokenId} not found`);
      return false;
    }
    const linkIds = [];
    const spanIds = [];
    const morphIds = [];
    let resetFirst = null;
    const collectAttached = (t) => {
      if (t.vocabItem?.prov === PROV_STATES.MACHINE) linkIds.push(t.vocabItem.linkId);
      for (const span of Object.values(t.annotations || {})) {
        if (span && isMachine(span.metadata)) spanIds.push(span.id);
      }
    };
    collectAttached(token);
    const morphs = [...(token.morphemes || [])].sort(
      (a, b) => (a.precedence ?? 0) - (b.precedence ?? 0),
    );
    const survivors = [];
    morphs.forEach((m, i) => {
      if (isMachine(m.metadata) && i > 0) {
        morphIds.push(m.id); // spans/links cascade with the token
        return;
      }
      survivors.push(m);
      collectAttached(m);
      if (isMachine(m.metadata)) resetFirst = m.id;
    });
    const renumber = survivors
      .map((m, i) => ({ id: m.id, precedence: i + 1 }))
      .filter(
        ({ id, precedence }) => (morphs.find((m) => m.id === id)?.precedence ?? 1) !== precedence,
      );

    if (!linkIds.length && !spanIds.length && !morphIds.length && !resetFirst) return true;

    return this._withSaving('Failed to discard word analysis', async () => {
      await this._client.batched(async () => {
        linkIds.forEach((id) => this._client.vocabLinks.delete(id));
        spanIds.forEach((id) => this._client.spans.delete(id));
        morphIds.forEach((id) => this._client.tokens.delete(id));
        if (resetFirst) {
          // patch semantics: null deletes the key
          this._client.tokens.patchMetadata(resetFirst, {
            form: null,
            morphType: null,
            prov: null,
            provSource: null,
            provDetail: null,
            provProb: null,
            provConfirmed: null,
          });
        }
        renumber.forEach(({ id, precedence }) =>
          this._client.tokens.update(id, undefined, undefined, precedence),
        );
      });
      await this._reload();
    });
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
    const confirm = PROV_CONFIRMED;
    const spanIds = [];
    const tokenIds = [];
    const linkIds = [];

    const collect = (t) => {
      if (t.vocabItem?.prov === PROV_STATES.MACHINE) linkIds.push(t.vocabItem.linkId);
      for (const span of Object.values(t.annotations || {})) {
        if (span && isMachine(span.metadata)) spanIds.push(span.id);
      }
      // Morpheme tokens (a copied segmentation) AND the word token itself (a
      // tokenizer service stamps prov on word tokens) confirm together.
      if (isMachine(t.metadata)) tokenIds.push(t.id);
    };
    collect(token);
    for (const m of token.morphemes || []) collect(m);

    if (!spanIds.length && !tokenIds.length && !linkIds.length) return true;

    return this._withSaving('Failed to confirm word analysis', async () => {
      await this._client.batched(async () => {
        tokenIds.forEach((id) => this._client.tokens.patchMetadata(id, confirm));
        linkIds.forEach((id) => this._client.vocabLinks.patchMetadata(id, confirm));
        spanIds.forEach((id) => this._client.spans.patchMetadata(id, confirm));
      });

      const spanSet = new Set(spanIds);
      const tokenSet = new Set(tokenIds);
      const linkSet = new Set(linkIds);
      this._applyRawPatch((next, infoNext, vocabs) => {
        for (const layer of [infoNext.primaryTokenLayer, infoNext.morphemeTokenLayer]) {
          (layer?.tokens || []).forEach((t) => {
            if (tokenSet.has(t.id)) t.metadata = { ...(t.metadata || {}), ...confirm };
          });
        }
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
