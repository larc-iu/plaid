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

import { stampInferred, mergeMetadata, PROV } from '@larc-iu/plaid-client';
import { CHUNK } from '../bulk.js';
import { isUnanalyzedWord, extractAnalysis, analysisSignature } from '../analysisMemory.js';
import { isVirtualMorphemeId } from '../virtualMorpheme.js';

// Entities per chunk. A chunk is one atomic batch, and the writes inside it go
// to the BULK endpoints, so its op count is a handful (one per entity kind,
// plus one per span layer) however many words it carries — what the budget
// bounds is the entities in one server transaction, and so how long it holds
// the single SQLite write lock against other writers.
const ANALYSIS_BATCH_BUDGET = 800;

// Entities one word's copy writes: the default-morpheme patch, a create per
// extra morpheme, and a link + fields for every slot and the word. Words are
// packed into chunks by this, and a chunk boundary never falls inside a word.
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

// Entities per atomic batch when stripping analyses (bulkReplaceAnalyses) is
// the ordinary bulk chunk: a chunk is at most five ops — a bulk delete per
// entity kind, one bulk metadata update, and the rare precedence fix — so
// what bounds it is the write-lock hold and not plaid-core's op cap.

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

  // "Analyze every ‹again› in this text like this", from the popover: one
  // word's analysis onto other words nobody has analyzed. A person pointed at
  // the analysis and asked for it, so it lands as their work (the writer's
  // create stamp: nothing for a verifier), as a re-analyze does. Words that
  // stopped being unanalyzed since the row was drawn are skipped. `confirm`
  // names the words the analysis came from: asking for it to be spread is
  // endorsing it, so they stop reading as somebody else's guess while their
  // copies read as this person's work. Returns the number of words written
  // (false on failure).
  async applyAnalysisToWords(wordTokenIds, analysis, { confirm = [] } = {}) {
    const todo = this._planAnalysisApply(
      (wordTokenIds || []).map((wordTokenId) => ({ wordTokenId, analysis })),
    );
    if (todo === false) return false;
    if (!todo.length) return 0;
    const ok = await this._withSaving('Failed to analyze words', async () => {
      await this._applyAnalysesImpl(todo, this.createStamp || {});
      if (confirm.length) {
        await this._client.batched(async (b) => {
          this._queueConfirm(b, confirm);
        });
        await this._reload();
      }
    });
    return ok ? todo.length : false;
  },

  // Bulk Edit's "re-analyze every occurrence": REPLACE each target word's
  // analysis with `analysis` (same shape as extractAnalysis), whatever it
  // carries now. Two phases under one operation: strip every link, span and
  // extra morpheme off the word (first morpheme reset to the healed default),
  // resync, then run the same apply path as a copy. A person chose this
  // analysis deliberately, so it lands as their work (the writer's create
  // stamp: nothing for a verifier), not as an unverified guess. Words already
  // carrying exactly the target analysis are skipped. Returns the number of
  // words changed (false on failure).
  async bulkReplaceAnalyses(proposals) {
    const targetSig = new Map();
    const targets = [];
    const already = [];
    for (const p of proposals || []) {
      const token = this.tokenLookup.get(p.wordTokenId);
      if (!token || !p.analysis) continue;
      let sig = targetSig.get(p.analysis);
      if (!sig) targetSig.set(p.analysis, (sig = analysisSignature(p.analysis)));
      const current = extractAnalysis(token);
      // Already carrying it: nothing to write, but this is one of the words
      // the person pointed at, so it stops reading as somebody else's guess.
      if (current && analysisSignature(current) === sig) {
        already.push(p.wordTokenId);
        continue;
      }
      targets.push({ wordTokenId: p.wordTokenId, analysis: p.analysis, token });
    }
    if (!targets.length) return 0;

    return (await this._withSaving('Failed to re-analyze words', async () => {
      // ---- phase 1: strip. Deleting a morpheme cascades its own spans and
      // links server-side, so only the word's and the surviving first
      // morpheme's are collected explicitly (a double delete fails the batch).
      // Collected by KIND, per word: a chunk goes out as one bulk delete per
      // kind plus one bulk metadata update, so stripping a thousand words
      // costs a handful of server dispatches rather than thousands. Grouped by
      // word so a chunk boundary never falls inside one, which would leave
      // that word half stripped if a later chunk failed.
      const byWord = [];
      for (const { token } of targets) {
        const strip = { links: [], spans: [], morphs: [], patches: [], renumber: [], size: 0 };
        byWord.push(strip);
        const collectAttached = (t) => {
          if (t.vocabItem?.linkId) strip.links.push(t.vocabItem.linkId);
          for (const span of Object.values(t.annotations || {})) {
            if (span?.id) strip.spans.push(span.id);
          }
        };
        collectAttached(token);
        const morphs = [...(token.morphemes || [])].sort(
          (a, b) => (a.precedence ?? 0) - (b.precedence ?? 0),
        );
        morphs.forEach((m, i) => {
          if (i > 0) {
            strip.morphs.push(m.id);
            return;
          }
          // An unanalyzed word's morpheme is derived, with nothing stored to
          // strip and an id the server has never seen. Sent, it refused the
          // whole batch, and the batches already sent had taken the analyses
          // off every word before it.
          if (isVirtualMorphemeId(m.id)) return;
          collectAttached(m);
          // patch semantics: null deletes the key
          strip.patches.push({
            id: m.id,
            metadata: {
              form: null,
              morphType: null,
              prov: null,
              provSource: null,
              provDetail: null,
              provProb: null,
              provConfirmed: null,
            },
          });
          // The apply path numbers created morphemes from 2, so the survivor
          // must sit at 1.
          if ((m.precedence ?? 1) !== 1) strip.renumber.push(m.id);
        });
        strip.size =
          strip.links.length +
          strip.spans.length +
          strip.morphs.length +
          strip.patches.length +
          strip.renumber.length;
      }
      // Order within a chunk does not matter: the spans and links collected
      // hang off the word and its surviving morpheme, never off a morpheme
      // being deleted, so nothing here can delete the same row twice.
      const sendStrip = async (words) => {
        const links = words.flatMap((w) => w.links);
        const spans = words.flatMap((w) => w.spans);
        const morphs = words.flatMap((w) => w.morphs);
        const patches = words.flatMap((w) => w.patches);
        const renumber = words.flatMap((w) => w.renumber);
        await this._client.batched(async (b) => {
          if (links.length) b.vocabLinks.bulkDelete(links);
          if (spans.length) b.spans.bulkDelete(spans);
          if (morphs.length) b.tokens.bulkDelete(morphs);
          if (patches.length) b.tokens.bulkUpdate(patches);
          // Precedence is a column, not metadata, and the bulk token update
          // carries metadata only, so the rare survivor that is not already
          // first gets an op of its own.
          renumber.forEach((id) => b.tokens.update(id, undefined, undefined, 1));
        });
      };
      let part = [];
      let partSize = 0;
      for (const word of [...byWord, null]) {
        if ((word === null || partSize + word.size > CHUNK) && part.length) {
          const words = part;
          part = [];
          partSize = 0;
          await sendStrip(words);
        }
        // A word with nothing stored to strip (an unanalyzed one, whose only
        // morpheme is derived) contributes no ops, and must not make an empty
        // batch look like work.
        if (word?.size) {
          part.push(word);
          partSize += word.size;
        }
      }
      await this._reload();

      // ---- phase 2: apply, exactly as a copy would (the words are now
      // unanalyzed single-morpheme words). No provenance stamp: human work.
      const todo = this._planAnalysisApply(
        targets.map(({ wordTokenId, analysis }) => ({ wordTokenId, analysis })),
      );
      if (todo === false) throw new Error('Morpheme layer not configured');
      await this._applyAnalysesImpl(todo, this.createStamp || {});
      // The occurrences that already carried this analysis are what the
      // person chose it from: they are confirmed with the rest.
      if (already.length) {
        await this._client.batched(async (b) => {
          this._queueConfirm(b, already);
        });
        await this._reload();
      }
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

    // Prediction extras (provenance convention): when the pieces carry a
    // provenance stamp (machine, or a contributor's), each copied span also
    // records the value it was given as provDetail.value and each copied
    // morpheme its segment as provDetail.form. The entity may be edited later;
    // that copy is what tells an accepted-as-is copy from a corrected one once
    // it is verified. A verifier's replace (empty stamp) records nothing.
    // Links need nothing: the item id is the guess.
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
      // A batch is one op per KIND, not per entity: the ops below are collected
      // across the whole chunk and sent as bulk creates, updates and deletes,
      // so a chunk of a hundred words costs the same handful of server
      // dispatches as a chunk of one. Spans group by layer as well, since a
      // bulk span create takes one layer.
      const bySpanLayer = (specs) => {
        const byLayer = new Map();
        for (const s of specs) {
          if (!byLayer.has(s.spanLayerId)) byLayer.set(s.spanLayerId, []);
          byLayer.get(s.spanLayerId).push(s);
        }
        return byLayer;
      };

      for (const chunk of chunks) {
        // Every word here is unanalyzed by definition, so its first morpheme is
        // usually the one derive synthesized rather than a stored token. Write
        // those first, in one bulk create, since batch 1 below addresses them
        // by id and a create inside a batch does not hand its id back.
        const firstIds = await this.materializeMorphemeIds(chunk.map((p) => p.m0.id));
        chunk.forEach((p, i) => {
          p.m0Id = firstIds[i];
        });
        const live = chunk.filter((p) => p.m0Id);

        // ---- batch 1: structure + everything addressable now ----
        const morphPatches = [];
        const morphCreates = [];
        const pendingMorphs = []; // created morphemes needing batch-2 links/spans, in create order
        const linkCreates = [];
        const spanCreates = [];
        const collectLinkAndSpans = (tokenId, slot, layersByName) => {
          const item = findVocabItem(this._vocabularies, slot.vocabItemId);
          if (item) linkCreates.push({ vocabItem: item.id, tokens: [tokenId], metadata: stamp });
          for (const [name, value] of Object.entries(slot.fields || {})) {
            const layer = layersByName.get(name);
            if (!layer) continue;
            spanCreates.push({
              spanLayerId: layer.id,
              tokens: [tokenId],
              value,
              metadata: stampValue(value),
            });
          }
        };

        for (const p of live) {
          const { token, m0Id, analysis } = p;
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
              morphPatches.push({ id: m0Id, metadata: merged });
            }
            collectLinkAndSpans(m0Id, s0, morphLayersByName);
          }
          // Remaining slots: create stamped morpheme tokens; their links/spans
          // wait for batch 2 (ids unknown until this batch lands).
          slots.slice(1).forEach((slot, j) => {
            morphCreates.push({
              tokenLayerId: morphemeLayer.id,
              text: textId,
              begin: token.begin,
              end: token.end,
              precedence: j + 2,
              metadata: {
                ...(slot.form != null ? { form: slot.form } : {}),
                ...(slot.morphType != null ? { morphType: slot.morphType } : {}),
                ...stampForm(slot.form),
              },
            });
            pendingMorphs.push(slot);
          });
          // Word-level link + fields.
          const wordItem = findVocabItem(this._vocabularies, analysis.word?.vocabItemId);
          if (wordItem) {
            linkCreates.push({ vocabItem: wordItem.id, tokens: [token.id], metadata: stamp });
          }
          for (const [name, value] of Object.entries(analysis.word?.fields || {})) {
            const layer = wordLayersByName.get(name);
            if (!layer) continue;
            spanCreates.push({
              spanLayerId: layer.id,
              tokens: [token.id],
              value,
              metadata: stampValue(value),
            });
          }
        }

        // The morpheme create goes FIRST so its ids are always results[0]:
        // nothing else in this batch addresses a morpheme it makes.
        const results = await this._client.batched(async (b) => {
          if (morphCreates.length) b.tokens.bulkCreate(morphCreates);
          if (morphPatches.length) b.tokens.bulkUpdate(morphPatches);
          if (linkCreates.length) b.vocabLinks.bulkCreate(linkCreates);
          for (const specs of bySpanLayer(spanCreates).values()) b.spans.bulkCreate(specs);
        });

        // ---- batch 2: links/spans for the created morphemes ----
        const newIds = morphCreates.length ? results[0]?.body?.ids || [] : [];
        const second = pendingMorphs
          .map((slot, i) => ({ slot, id: newIds[i] }))
          .filter(
            ({ slot, id }) => id && (slot.vocabItemId || Object.keys(slot.fields || {}).length),
          );
        if (second.length) {
          const secondLinks = [];
          const secondSpans = [];
          for (const { slot, id } of second) {
            const item = findVocabItem(this._vocabularies, slot.vocabItemId);
            if (item) secondLinks.push({ vocabItem: item.id, tokens: [id], metadata: stamp });
            for (const [name, value] of Object.entries(slot.fields || {})) {
              const layer = morphLayersByName.get(name);
              if (!layer) continue;
              secondSpans.push({
                spanLayerId: layer.id,
                tokens: [id],
                value,
                metadata: stampValue(value),
              });
            }
          }
          await this._client.batched(async (b) => {
            if (secondLinks.length) b.vocabLinks.bulkCreate(secondLinks);
            for (const specs of bySpanLayer(secondSpans).values()) b.spans.bulkCreate(specs);
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
  // a proposed first morpheme is reset to the healed default state (form,
  // morphType and prov keys dropped). "Proposed" is what this writer
  // reviews (doc.reviewable: machine and contributed material for a
  // verifier, machine only for a contributor); everything else is left
  // alone, so a mixed word keeps its vouched-for parts; survivors are
  // renumbered so precedence stays gap-free. Ends with a reload (several
  // entity families change at once). No-op (true) when nothing is proposed.
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
      if (this.reviewableState(t.vocabItem?.prov)) linkIds.push(t.vocabItem.linkId);
      for (const span of Object.values(t.annotations || {})) {
        if (span && this.reviewable(span.metadata)) spanIds.push(span.id);
      }
    };
    collectAttached(token);
    const morphs = [...(token.morphemes || [])].sort(
      (a, b) => (a.precedence ?? 0) - (b.precedence ?? 0),
    );
    const survivors = [];
    morphs.forEach((m, i) => {
      if (this.reviewable(m.metadata) && i > 0) {
        morphIds.push(m.id); // spans/links cascade with the token
        return;
      }
      survivors.push(m);
      collectAttached(m);
      if (this.reviewable(m.metadata)) resetFirst = m.id;
    });
    const renumber = survivors
      .map((m, i) => ({ id: m.id, precedence: i + 1 }))
      .filter(
        ({ id, precedence }) => (morphs.find((m) => m.id === id)?.precedence ?? 1) !== precedence,
      );

    if (!linkIds.length && !spanIds.length && !morphIds.length && !resetFirst) return true;

    return this._withSaving('Failed to discard word analysis', async () => {
      await this._client.batched(async (b) => {
        linkIds.forEach((id) => b.vocabLinks.delete(id));
        spanIds.forEach((id) => b.spans.delete(id));
        morphIds.forEach((id) => b.tokens.delete(id));
        if (resetFirst) {
          // patch semantics: null deletes the key
          b.tokens.patchMetadata(resetFirst, {
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
          b.tokens.update(id, undefined, undefined, precedence),
        );
      });
      await this._reload();
    });
  },

  // Accept everything proposed on one word at once — the deliberate "this whole
  // word looks right" gesture (Ctrl/Cmd+Enter in the editor). Two kinds of
  // proposal, one gesture, because on screen they are both marked and the
  // annotator is vouching for the word either way:
  //   - material already stored that this writer reviews (the word's link +
  //     spans, each morpheme's token metadata, link and spans) merges the
  //     writer's confirm stamp: provConfirmed for a verifier, the contributed
  //     stamp for a contributor accepting a machine proposal;
  //   - `adoptions` are cells showing a guess, which is NOT stored at all (it
  //     is a placeholder computed from the linked entry or project precedent —
  //     see domain/glossGuess.js), so each becomes a new span written exactly
  //     as the single-cell adoption on plain Enter writes it. What a guess is
  //     stays the editor's business: an adoption is just
  //     { targetId, field, value, metadata }, where targetId is this word or
  //     one of its morphemes.
  // No-op (true) when there is nothing to confirm and nothing to adopt.
  // What this writer can confirm on `words` and their morphemes: the links,
  // the annotation spans and the tokens that are somebody else's unconfirmed
  // work. Morpheme tokens (a copied segmentation) AND the word token itself
  // (a tokenizer service stamps prov on word tokens) confirm together.
  _reviewableIdsOf(words) {
    const spanIds = [];
    const tokenIds = [];
    const linkIds = [];
    const collect = (t) => {
      if (this.reviewableState(t.vocabItem?.prov)) linkIds.push(t.vocabItem.linkId);
      for (const span of Object.values(t.annotations || {})) {
        if (span && this.reviewable(span.metadata)) spanIds.push(span.id);
      }
      if (this.reviewable(t.metadata)) tokenIds.push(t.id);
    };
    for (const token of words) {
      if (!token) continue;
      collect(token);
      for (const m of token.morphemes || []) collect(m);
    }
    return { spanIds, tokenIds, linkIds };
  },

  // Confirm what `wordTokenIds` carry of somebody else's unconfirmed work, on
  // the batch `b`. Spreading an analysis is endorsing it, so the word it was
  // copied from stops reading as a guess while its copies read as this
  // person's own work.
  _queueConfirm(b, wordTokenIds) {
    const words = (wordTokenIds || []).map((id) => this.tokenLookup.get(id)).filter(Boolean);
    if (!words.length) return false;
    const { spanIds, tokenIds, linkIds } = this._reviewableIdsOf(words);
    if (!spanIds.length && !tokenIds.length && !linkIds.length) return false;
    const confirm = this.confirmStamp(stampInferred('any'));
    tokenIds.forEach((id) => b.tokens.patchMetadata(id, confirm));
    linkIds.forEach((id) => b.vocabLinks.patchMetadata(id, confirm));
    spanIds.forEach((id) => b.spans.patchMetadata(id, confirm));
    return true;
  },

  async confirmWordAnalysis(wordTokenId, adoptions = []) {
    const token = this.tokenLookup.get(wordTokenId);
    if (!token) {
      this.setError(`Word ${wordTokenId} not found`);
      return false;
    }
    // One writer, one stamp: what it merges does not depend on the entity.
    const confirm = this.confirmStamp(stampInferred('any'));
    const { spanIds, tokenIds, linkIds } = this._reviewableIdsOf([token]);

    // Resolve adoptions against the word itself: the scope follows the target,
    // and a cell that gained a value between the render and the keypress is
    // skipped rather than given a second span on the same token.
    const writes = [];
    for (const { targetId, field, value, metadata } of adoptions) {
      const target =
        targetId === token.id ? token : (token.morphemes || []).find((m) => m.id === targetId);
      if (!target || !value || target.annotations?.[field]?.id) continue;
      const scope = target === token ? 'word' : 'morpheme';
      const layer = (this.layerInfo.spanLayers?.[scope] || []).find((sl) => sl.name === field);
      if (!layer) continue;
      writes.push({ layerId: layer.id, targetId, value, metadata });
    }

    if (!spanIds.length && !tokenIds.length && !linkIds.length && !writes.length) return true;

    return this._withSaving('Failed to confirm word analysis', async () => {
      // An adoption can target the morpheme derive synthesized for a word
      // nobody has segmented, which is the ordinary case for a guessed gloss.
      // Write those morphemes before the batch that points spans at them: a
      // create inside a batch does not hand its id back. A word-scope target
      // passes through untouched.
      const adoptIds = await this.materializeMorphemeIds(writes.map((w) => w.targetId));
      const live = writes
        .map((w, i) => ({ ...w, targetId: adoptIds[i] }))
        .filter((w) => w.targetId);

      await this._client.batched(async (b) => {
        tokenIds.forEach((id) => b.tokens.patchMetadata(id, confirm));
        linkIds.forEach((id) => b.vocabLinks.patchMetadata(id, confirm));
        spanIds.forEach((id) => b.spans.patchMetadata(id, confirm));
        live.forEach((w) =>
          b.spans.create(w.layerId, [w.targetId], w.value, w.metadata || undefined),
        );
      });

      // Adopted guesses are new spans whose ids only the server knows, so the
      // optimistic patch below (which can only touch rows already in hand)
      // can't represent them: resync instead. Pure confirmation, the common
      // case in a sweep, keeps the patch and stays reload-free.
      if (writes.length) {
        await this._reload();
        return;
      }

      const spanSet = new Set(spanIds);
      const tokenSet = new Set(tokenIds);
      const linkSet = new Set(linkIds);
      this._applyRawPatch((next, infoNext, vocabs) => {
        for (const layer of [infoNext.primaryTokenLayer, infoNext.morphemeTokenLayer]) {
          (layer?.tokens || []).forEach((t) => {
            if (tokenSet.has(t.id)) t.metadata = mergeMetadata(t.metadata, confirm);
          });
        }
        for (const scope of ['word', 'morpheme']) {
          (infoNext.spanLayers?.[scope] || []).forEach((sl) => {
            (sl.spans || []).forEach((s) => {
              if (spanSet.has(s.id)) s.metadata = mergeMetadata(s.metadata, confirm);
            });
          });
        }
        Object.values(vocabs || {}).forEach((vocab) => {
          (vocab.vocabLinks || []).forEach((l) => {
            if (linkSet.has(l.id)) l.metadata = mergeMetadata(l.metadata, confirm);
          });
        });
      });
    });
  },
};
