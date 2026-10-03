// Mutation mixin: whole-word analysis copies (see domain/analysisMemory.js).
// Applies [{ wordTokenId, analysis }] proposals: the word's single default
// morpheme becomes the analysis's first slot, further slots are created, and
// vocab links + annotation spans are written for every slot — all stamped
// { prov: 'inferred', provSource } so they render as unverified.
//
// One batch per chunk of words: the morphemes a copy makes, the patches, and
// the links and fields, the links and fields naming a morpheme made in the
// same batch by the batch's reference to its id. A chunk lands whole or not
// at all, so a refusal never leaves a word with its segmentation and without
// its glosses.
//
// Ends with one _reload() instead of optimistic patches: a copy touches up to
// four entity families per word, and the auto-pass that drives this runs
// outside any focused-cell interaction, so a full resync is the simple,
// correct move (same as the service-backed auto-link path).

import {
  applyMetadataOps,
  stampInferred,
  mergeMetadata,
  metadataOps,
  PROV,
  createdId,
  createdIds,
} from '@larc-iu/plaid-client';
import { pendingId, settledId } from '@ui/domain/pendingIds.js';
import { isUnanalyzedWord, extractAnalysis, analysisSignature } from '../analysisMemory.js';
import { isVirtualMorphemeId } from '../virtualMorpheme.js';
import { notSetUp } from '@ui/domain/setupGuard.js';

// Entities per chunk. A chunk is one atomic batch, and the writes inside it go
// to the BULK endpoints, so its op count is a handful (one per entity kind,
// plus one per span layer) however many words it carries — what the budget
// bounds is the entities in one server transaction, and so how long it holds
// the single SQLite write lock against other writers.
const ANALYSIS_BATCH_BUDGET = 800;

// The metadata ops that return a surviving default morpheme to a bare slot:
// no form, no type, no provenance.
const RESET_MORPHEME_OPS = [
  'form',
  'morphType',
  'prov',
  'provSource',
  'provDetail',
  'provProb',
  'provConfirmed',
].map((key) => ({ op: 'delete', path: [key] }));

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

// Entities per atomic batch when stripping analyses (bulkReplaceAnalyses) is
// the ordinary bulk chunk: a chunk is at most five ops — a bulk delete per
// entity kind, one bulk metadata update, and the rare precedence fix — so
// what bounds it is the write-lock hold and not plaid-core's op cap.

// The vocabulary an entry is in, and the shape a document read gives a link's
// entry (id, layer, form), or null when no loaded vocabulary has it.
const findVocabHome = (vocabularies, vocabItemId) => {
  if (!vocabItemId) return null;
  for (const vocab of Object.values(vocabularies || {})) {
    const item = (vocab.items || []).find((i) => i.id === vocabItemId);
    if (item)
      return { vocabId: vocab.id, snapshot: { id: item.id, layer: vocab.id, form: item.form } };
  }
  return null;
};

// What stripping a word's analysis deletes and resets, by kind. Deleting a
// morpheme cascades its own spans and links server-side, so only the word's
// and the surviving first morpheme's are collected (a double delete fails the
// batch). An unanalyzed word's morpheme is derived, with nothing stored to
// strip and an id the server has never seen, which sent refused the batch.
const stripOf = (token) => {
  const strip = { links: [], spans: [], morphs: [], patches: [], renumber: [], size: 0 };
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
    if (isVirtualMorphemeId(m.id)) return;
    collectAttached(m);
    strip.patches.push({ id: m.id, metadata: RESET_MORPHEME_OPS });
    // The apply path numbers created morphemes from 2, so the survivor must
    // sit at 1.
    if ((m.precedence ?? 1) !== 1) strip.renumber.push(m.id);
  });
  strip.size =
    strip.links.length +
    strip.spans.length +
    strip.morphs.length +
    strip.patches.length +
    strip.renumber.length;
  return strip;
};

// Queue `strips` on batch `b`: one bulk delete per kind and one bulk
// metadata update, however many words. Order does not matter: what is
// collected hangs off the word and its surviving morpheme, never off a
// morpheme being deleted, so nothing is deleted twice.
const queueStrip = (b, strips) => {
  const all = (k) => strips.flatMap((w) => w[k]).map(settledId);
  const links = all('links');
  const spans = all('spans');
  const morphs = all('morphs');
  const patches = strips.flatMap((w) => w.patches).map((p) => ({ ...p, id: settledId(p.id) }));
  if (links.length) b.vocabLinks.bulkDelete(links);
  if (spans.length) b.spans.bulkDelete(spans);
  if (morphs.length) b.tokens.bulkDelete(morphs);
  if (patches.length) b.tokens.bulkUpdate(patches);
  // Precedence is a column, not metadata, and the bulk token update carries
  // metadata only, so the rare survivor that is not already first gets an op
  // of its own.
  all('renumber').forEach((id) => b.tokens.update(id, undefined, undefined, 1));
};

export const analysisCopyMutations = {
  // Returns the number of words a copy was applied to (false on failure).
  // `detail` is the producer's own provDetail (a built-in rule's model and
  // version), kept beside what each piece predicted. `kind` and `ref` are the
  // write's operation (a built-in rule's is a service run naming it).
  async bulkApplyAnalyses(proposals, provSource, { detail, kind, ref } = {}) {
    const todo = this._planAnalysisApply(proposals);
    if (todo === false) return false;
    if (!todo.length) return 0;
    const label = 'Failed to copy previous analyses';
    if (!this._canWrite(label)) return false;
    const plan = this._planAnalysesApply(todo, stampInferred(provSource, { detail }));
    this._showAnalysesApply(plan);
    const ok = await this._queueWrite(label, () => this._sendAnalysesApply(plan), undefined, {
      kind,
      ref,
    });
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
    const label = 'Failed to analyze words';
    if (!this._canWrite(label)) return false;
    const plan = this._planAnalysesApply(todo, this.createStamp || {});
    this._showAnalysesApply(plan);
    const confirmed = this._showConfirm(confirm);
    const ok = await this._queueWrite(label, async () => {
      await this._sendAnalysesApply(plan);
      if (confirmed) {
        await this._client.batched(async (b) => {
          this._sendConfirm(b, confirmed);
        });
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

    // Chunks of words, each ONE batch holding their strip and their new
    // analysis, so a word is never left stripped and not re-analyzed. A
    // refusal stops the run where it is: the chunks before it landed whole,
    // and the caller re-plans the rest from a fresh read (bulkRunner.js).
    const chunks = [];
    let cur = [];
    let curSize = 0;
    for (const t of targets) {
      const size = stripOf(t.token).size + opsForWord(t);
      if (cur.length && curSize + size > ANALYSIS_BATCH_BUDGET) {
        chunks.push(cur);
        cur = [];
        curSize = 0;
      }
      cur.push(t);
      curSize += size;
    }
    if (cur.length) chunks.push(cur);

    return (await this._queueWrite('Failed to re-analyze words', async () => {
      for (const chunk of chunks) {
        // Planned on the document as it stands now, after the chunks before.
        const strips = chunk
          .map(({ wordTokenId }) => this.tokenLookup.get(wordTokenId))
          .filter(Boolean)
          .map(stripOf);
        this._showStrip(strips);
        // The words are now unanalyzed single-morpheme words, and take the
        // target as a copy would. No provenance stamp: human work.
        const todo = this._planAnalysisApply(
          chunk.map(({ wordTokenId, analysis }) => ({ wordTokenId, analysis })),
        );
        if (todo === false) throw new Error(notSetUp('Morpheme layer not configured'));
        const plan = this._planAnalysesApply(todo, this.createStamp || {});
        this._showAnalysesApply(plan);
        const ids = new Map();
        await this._sendAnalysesChunk(plan.words, ids, (b) => queueStrip(b, strips));
        this._settle(ids);
      }
      // The occurrences that already carried this analysis are what the
      // person chose it from: they are confirmed with the rest.
      if (already.length) {
        await this._client.batched(async (b) => {
          this._queueConfirm(b, already);
        });
        await this._reloadInSend();
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
      this.setError(notSetUp('Morpheme layer not configured'));
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

  // A copy in three parts, so a person's "analyze every ‹x› like this" shows at
  // once: the plan (every piece under a pending id), the patch, and the send.
  // `_applyAnalysesImpl` runs all three, for the callers already inside a
  // send. `stamp` is the metadata merged into every created/patched piece
  // ({} for none).
  async _applyAnalysesImpl(todo, stamp) {
    const plan = this._planAnalysesApply(todo, stamp);
    this._showAnalysesApply(plan);
    await this._sendAnalysesApply(plan);
  },

  _planAnalysesApply(todo, stamp) {
    const info = this.layerInfo;
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
    const withDetail = (detail) =>
      machine ? { ...stamp, [PROV.detailKey]: { ...stamp[PROV.detailKey], ...detail } } : stamp;
    const stampValue = (value) => withDetail({ value });
    const stampForm = (form) => (form == null ? stamp : withDetail({ form }));

    // Every word here is unanalyzed by definition, so its first morpheme is
    // usually the one derive synthesized rather than a stored token: it is
    // made along with the rest, carrying the first slot's patch. Only where
    // the copy puts something on it, though: a precedent whose first slot
    // carries nothing (its analysis is all on the word) would otherwise store
    // a morpheme with every field derivable.
    const firstCarries = ({ token, analysis }) => {
      const slots = analysis.morphemes || [];
      const s0 = slots[0];
      if (slots.length > 1) return true;
      if (!s0) return false;
      return (
        (s0.form != null && s0.form !== token.content) ||
        s0.morphType != null ||
        !!findVocabHome(this._vocabularies, s0.vocabItemId) ||
        Object.keys(s0.fields || {}).some((name) => morphLayersByName.has(name))
      );
    };
    const carries = todo.map(firstCarries);
    // The first morpheme is the copy's, so it carries the copy's stamp (a
    // machine copy makes a machine morpheme), never the requester's.
    const { ids: firstIds, creates: firstCreates } = this._planMorphemes(
      todo.map((p, i) => (carries[i] ? p.m0.id : null)),
      undefined,
      { stamp },
    );
    const createdFirst = new Map(firstCreates.map((c) => [c.id, c]));
    const words = [];
    todo.forEach((p, i) => {
      const m0Id = firstIds[i];
      if (carries[i] && !m0Id) return;
      const { token, analysis } = p;
      const word = { m0Id, create: createdFirst.get(m0Id) || null, patch: null, extra: [] };
      word.links = [];
      word.spans = [];
      const linkTo = (tokenId, vocabItemId, into) => {
        const found = findVocabHome(this._vocabularies, vocabItemId);
        if (found) into.links.push({ id: pendingId(), tokenId, ...found, metadata: stamp });
      };
      const spansOn = (tokenId, fields, layersByName, into) => {
        for (const [name, value] of Object.entries(fields || {})) {
          const layer = layersByName.get(name);
          if (!layer) continue;
          into.spans.push({
            id: pendingId(),
            layerId: layer.id,
            tokenId,
            value,
            metadata: stampValue(value),
          });
        }
      };
      const slots = analysis.morphemes || [];
      const s0 = carries[i] ? slots[0] || null : null;
      // First slot reuses the default morpheme. Only stamp the token when the
      // copy actually changes its segmentation-tier data (form/morphType):
      // links/spans carry their own provenance.
      if (s0) {
        const patch = {};
        if (s0.form != null && s0.form !== token.content) patch.form = s0.form;
        if (s0.morphType != null) patch.morphType = s0.morphType;
        const merged = { ...patch, ...stampForm(s0.form) };
        if (Object.keys(merged).length && (Object.keys(patch).length || slots.length > 1)) {
          if (word.create) word.create.metadata = { ...word.create.metadata, ...merged };
          else word.patch = merged;
        }
        linkTo(m0Id, s0.vocabItemId, word);
        spansOn(m0Id, s0.fields, morphLayersByName, word);
      }
      // Remaining slots: new morphemes, with their own links and fields.
      slots.slice(1).forEach((slot, j) => {
        const m = {
          id: pendingId(),
          begin: token.begin,
          end: token.end,
          precedence: j + 2,
          metadata: {
            ...(slot.form != null ? { form: slot.form } : {}),
            ...(slot.morphType != null ? { morphType: slot.morphType } : {}),
            ...stampForm(slot.form),
          },
          links: [],
          spans: [],
        };
        linkTo(m.id, slot.vocabItemId, m);
        spansOn(m.id, slot.fields, morphLayersByName, m);
        word.extra.push(m);
      });
      // Word-level link + fields.
      linkTo(token.id, analysis.word?.vocabItemId, word);
      spansOn(token.id, analysis.word?.fields, wordLayersByName, word);
      word.ops = opsForWord(p);
      words.push(word);
    });
    return { words };
  },

  _showAnalysesApply({ words }) {
    const textId = this.layerInfo.primaryTextLayer?.text?.id;
    this._applyRawPatch((next, info, vocabs) => {
      this._showMorphemes(info, words.map((w) => w.create).filter(Boolean));
      const layer = info.morphemeTokenLayer;
      words.forEach((w) => {
        if (w.patch) {
          const m = (layer.tokens || []).find((x) => x.id === w.m0Id);
          if (m) m.metadata = mergeMetadata(m.metadata, w.patch);
        }
        w.extra.forEach((m) =>
          layer.tokens.push({
            id: m.id,
            text: textId,
            begin: m.begin,
            end: m.end,
            precedence: m.precedence,
            metadata: m.metadata,
          }),
        );
        for (const owner of [w, ...w.extra]) {
          owner.links.forEach((l) => {
            const v = vocabs[l.vocabId];
            if (!v) return;
            if (!Array.isArray(v.vocabLinks)) v.vocabLinks = [];
            v.vocabLinks.push({
              id: l.id,
              tokens: [l.tokenId],
              vocabItem: l.snapshot,
              ...(Object.keys(l.metadata || {}).length ? { metadata: l.metadata } : {}),
            });
          });
          owner.spans.forEach((s) => {
            const sl = [
              ...(info.spanLayers?.word || []),
              ...(info.spanLayers?.morpheme || []),
            ].find((x) => x.id === s.layerId);
            if (!sl) return;
            if (!Array.isArray(sl.spans)) sl.spans = [];
            sl.spans.push({
              id: s.id,
              tokens: [s.tokenId],
              value: s.value,
              ...(Object.keys(s.metadata || {}).length ? { metadata: s.metadata } : {}),
            });
          });
        }
      });
    });
  },

  // Show `strips` (stripOf) taken off the document: what the server does
  // with them, its cascades included.
  _showStrip(strips) {
    const gone = (k) => new Set(strips.flatMap((w) => w[k]));
    const links = gone('links');
    const spans = gone('spans');
    const morphs = gone('morphs');
    const reset = gone('patches').size
      ? new Set(strips.flatMap((w) => w.patches.map((p) => p.id)))
      : new Set();
    const renumber = gone('renumber');
    this._applyRawPatch((next, info, vocabs) => {
      const hangsOff = (tokens) => (tokens || []).some((t) => morphs.has(t));
      Object.values(vocabs || {}).forEach((v) => {
        if (!Array.isArray(v.vocabLinks)) return;
        v.vocabLinks = v.vocabLinks.filter((l) => !links.has(l.id) && !hangsOff(l.tokens));
      });
      for (const layer of [
        ...(info.spanLayers?.word || []),
        ...(info.spanLayers?.morpheme || []),
      ]) {
        if (!Array.isArray(layer.spans)) continue;
        layer.spans = layer.spans.filter((sp) => !spans.has(sp.id) && !hangsOff(sp.tokens));
      }
      const layer = info.morphemeTokenLayer;
      if (!layer || !Array.isArray(layer.tokens)) return;
      layer.tokens = layer.tokens.filter((m) => !morphs.has(m.id));
      layer.tokens.forEach((m) => {
        if (reset.has(m.id)) m.metadata = applyMetadataOps(m.metadata || {}, RESET_MORPHEME_OPS);
        if (renumber.has(m.id)) m.precedence = 1;
      });
    });
  },

  // A large unanalyzed document can emit far more than one batch's worth of
  // ops (this runs unattended from the auto-analysis pass). Words are packed
  // into chunks under the server cap; each chunk runs its own writes
  // atomically. Partial progress across chunks is fine: a copied word is no
  // longer unanalyzed, so it won't be silently re-targeted, and it keeps a
  // too-big copy from failing forever and re-triggering the pass on reload.
  async _sendAnalysesApply({ words }) {
    const ids = new Map();
    const chunks = [];
    let cur = [];
    let curOps = 0;
    for (const w of words) {
      if (cur.length && curOps + w.ops > ANALYSIS_BATCH_BUDGET) {
        chunks.push(cur);
        cur = [];
        curOps = 0;
      }
      cur.push(w);
      curOps += w.ops;
    }
    if (cur.length) chunks.push(cur);

    for (const chunk of chunks) await this._sendAnalysesChunk(chunk, ids);
    this._settle(ids);
  },

  // One chunk of a copy (`_planAnalysesApply`'s words) in one batch, after
  // whatever `before(b)` queues first: the default morphemes nobody had
  // stored, the new morphemes, the first morphemes' patches, then every link
  // and field, which name a morpheme made here by the batch's reference to
  // its id. A batch is one op per KIND, not per entity (spans one per layer,
  // since a bulk span create takes one layer), so a chunk of a hundred words
  // costs the same handful of server dispatches as a chunk of one. Records
  // the new ids in `ids`.
  async _sendAnalysesChunk(chunk, ids, before = null) {
    const info = this.layerInfo;
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    const extra = chunk.flatMap((w) => w.extra);
    const patches = chunk.filter((w) => w.patch);
    const owners = [...chunk, ...extra];
    const links = owners.flatMap((o) => o.links);
    const spans = owners.flatMap((o) => o.spans);
    const byLayer = new Map();
    spans.forEach((s) => {
      if (!byLayer.has(s.layerId)) byLayer.set(s.layerId, []);
      byLayer.get(s.layerId).push(s);
    });
    let first;
    let extraAt = null;
    let linksAt = null;
    const spansAt = [];
    const results = await this._client.batched(async (b) => {
      before?.(b);
      first = this._queueMorphemes(b, chunk.map((w) => w.create).filter(Boolean));
      const extraRefs = new Map();
      if (extra.length) {
        b.tokens.bulkCreate(
          extra.map((m) => ({
            id: m.id,
            tokenLayerId: morphemeLayer.id,
            text: textId,
            begin: m.begin,
            end: m.end,
            precedence: m.precedence,
            metadata: m.metadata,
          })),
        );
        extraAt = b.ref().$ref;
        extra.forEach((m, k) => extraRefs.set(m.id, b.ref(extraAt, k)));
      }
      const tokenRef = (id) => extraRefs.get(id) ?? first.tokenRef(id);
      if (patches.length) {
        b.tokens.bulkUpdate(
          patches.map((w) => ({ id: settledId(w.m0Id), metadata: metadataOps(w.patch) })),
        );
      }
      if (links.length) {
        b.vocabLinks.bulkCreate(
          links.map((l) => ({
            id: l.id,
            vocabItem: settledId(l.snapshot.id),
            tokens: [tokenRef(l.tokenId)],
            metadata: l.metadata,
          })),
        );
        linksAt = b.ref().$ref;
      }
      for (const [layerId, specs] of byLayer) {
        b.spans.bulkCreate(
          specs.map((s) => ({
            id: s.id,
            spanLayerId: layerId,
            tokens: [tokenRef(s.tokenId)],
            value: s.value,
            metadata: s.metadata,
          })),
        );
        spansAt.push(b.ref().$ref);
      }
    });
    first.read(results, ids);
    if (extraAt != null) {
      const newIds = createdIds(results[extraAt]);
      extra.forEach((m, i) => ids.set(m.id, newIds[i]));
    }
    if (linksAt != null) {
      const linkIds = createdIds(results[linksAt]);
      links.forEach((l, i) => ids.set(l.id, linkIds[i]));
    }
    [...byLayer.values()].forEach((specs, j) => {
      const spanIds = createdIds(results[spansAt[j]]);
      specs.forEach((s, i) => ids.set(s.id, spanIds[i]));
    });
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
      this.setError('Word not found');
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
    const label = 'Failed to discard word analysis';
    if (!this._canWrite(label)) return false;

    // The whole discard shows at once, the server's cascade included: a
    // deleted morpheme takes its spans and links with it.
    const goneTokens = new Set(morphIds);
    const goneSpans = new Set(spanIds);
    const goneLinks = new Set(linkIds);
    const precedenceOf = new Map(renumber.map((r) => [r.id, r.precedence]));
    this._applyRawPatch((next, info, vocabs) => {
      const layer = info.morphemeTokenLayer;
      if (layer && Array.isArray(layer.tokens)) {
        layer.tokens = layer.tokens.filter((m) => !goneTokens.has(m.id));
        layer.tokens.forEach((m) => {
          if (m.id === resetFirst)
            m.metadata = applyMetadataOps(m.metadata || {}, RESET_MORPHEME_OPS);
          if (precedenceOf.has(m.id)) m.precedence = precedenceOf.get(m.id);
        });
      }
      for (const scope of ['word', 'morpheme']) {
        (info.spanLayers?.[scope] || []).forEach((sl) => {
          if (!Array.isArray(sl.spans)) return;
          sl.spans = sl.spans.filter(
            (s) => !goneSpans.has(s.id) && !(s.tokens || []).some((t) => goneTokens.has(t)),
          );
        });
      }
      Object.values(vocabs || {}).forEach((vocab) => {
        if (!Array.isArray(vocab.vocabLinks)) return;
        vocab.vocabLinks = vocab.vocabLinks.filter(
          (l) => !goneLinks.has(l.id) && !(l.tokens || []).some((t) => goneTokens.has(t)),
        );
      });
    });

    return this._queueWrite(label, () =>
      this._client.batched(async (b) => {
        linkIds.forEach((id) => b.vocabLinks.delete(settledId(id)));
        spanIds.forEach((id) => b.spans.delete(settledId(id)));
        morphIds.forEach((id) => b.tokens.delete(settledId(id)));
        if (resetFirst) {
          b.tokens.patchMetadata(settledId(resetFirst), RESET_MORPHEME_OPS);
        }
        renumber.forEach(({ id, precedence }) =>
          b.tokens.update(settledId(id), undefined, undefined, precedence),
        );
      }),
    );
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

  // Confirm what `wordTokenIds` carry of somebody else's unconfirmed work,
  // shown at once. Spreading an analysis is endorsing it, so the word it was
  // copied from stops reading as a guess while its copies read as this
  // person's own work. Answers what `_sendConfirm` sends, or null when there
  // is nothing to confirm.
  _showConfirm(wordTokenIds) {
    const words = (wordTokenIds || []).map((id) => this.tokenLookup.get(id)).filter(Boolean);
    if (!words.length) return null;
    const { spanIds, tokenIds, linkIds } = this._reviewableIdsOf(words);
    if (!spanIds.length && !tokenIds.length && !linkIds.length) return null;
    const confirm = this.confirmStamp(stampInferred('any'));
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
    return { spanIds, tokenIds, linkIds, ops: metadataOps(confirm) };
  },

  _sendConfirm(b, { spanIds, tokenIds, linkIds, ops }) {
    tokenIds.forEach((id) => b.tokens.patchMetadata(settledId(id), ops));
    linkIds.forEach((id) => b.vocabLinks.patchMetadata(settledId(id), ops));
    spanIds.forEach((id) => b.spans.patchMetadata(settledId(id), ops));
  },

  // The same for a caller already inside a send, on its batch `b`. Answers
  // whether there was anything to confirm.
  _queueConfirm(b, wordTokenIds) {
    const confirmed = this._showConfirm(wordTokenIds);
    if (!confirmed) return false;
    this._sendConfirm(b, confirmed);
    return true;
  },

  // The adoptions an accept of this word writes now, resolved against the word
  // itself: the scope follows the target, a target outside the word or a
  // field with no layer writes nothing, and a cell that gained a value between
  // the render and the keypress is skipped rather than written over. A stored
  // EMPTY value is no value (the cell draws empty, with the guess in it, and
  // Enter there writes the guess over it), so the guess goes onto that span.
  // Each write carries the adoption it came from.
  _wordAdoptionWrites(token, adoptions) {
    const writes = [];
    for (const adoption of adoptions) {
      const { targetId, field, value, metadata } = adoption;
      const target =
        targetId === token.id ? token : (token.morphemes || []).find((m) => m.id === targetId);
      if (!target || !value) continue;
      const stored = target.annotations?.[field];
      if (stored?.id && (stored.value ?? '') !== '') continue;
      const scope = target === token ? 'word' : 'morpheme';
      const layer = (this.layerInfo.spanLayers?.[scope] || []).find((sl) => sl.name === field);
      if (!layer) continue;
      const spanId = stored?.id ?? null;
      writes.push({ layerId: layer.id, scope, targetId, value, metadata, spanId, adoption });
    }
    return writes;
  },

  // Which of `adoptions` confirmWordAnalysis(wordTokenId, adoptions) would
  // write now: what a caller that reports the answers counts as taken.
  wordAdoptionsWritten(wordTokenId, adoptions = []) {
    const token = this.tokenLookup.get(wordTokenId);
    if (!token) return [];
    const writes = this._wordAdoptionWrites(token, adoptions);
    const { ids } = this._planMorphemes(writes.map((w) => w.targetId));
    return writes.filter((w, i) => ids[i]).map((w) => w.adoption);
  },

  async confirmWordAnalysis(wordTokenId, adoptions = []) {
    const token = this.tokenLookup.get(wordTokenId);
    if (!token) {
      this.setError('Word not found');
      return false;
    }
    // One writer, one stamp: what it merges does not depend on the entity.
    const confirm = this.confirmStamp(stampInferred('any'));
    const confirmOps = metadataOps(confirm);
    const { spanIds, tokenIds, linkIds } = this._reviewableIdsOf([token]);

    const writes = this._wordAdoptionWrites(token, adoptions);

    if (!spanIds.length && !tokenIds.length && !linkIds.length && !writes.length) return true;
    const label = 'Failed to accept word analysis';
    if (!this._canWrite(label)) return false;

    // An adoption can target the morpheme derive synthesized for a word
    // nobody has segmented, which is the ordinary case for a guessed gloss:
    // that morpheme is made too. Each adopted guess is a new span, or goes
    // onto the stored empty one, and all of it shows at once.
    const { ids: targets, creates } = this._planMorphemes(writes.map((w) => w.targetId));
    const live = writes
      .map((w, i) => ({ ...w, targetId: targets[i], id: w.spanId ?? pendingId() }))
      .filter((w) => w.targetId);
    // A guess over a stored empty value is written onto that span, the rest
    // are new spans.
    const over = live.filter((w) => w.spanId);
    const fresh = live.filter((w) => !w.spanId);

    const spanSet = new Set(spanIds);
    const tokenSet = new Set(tokenIds);
    const linkSet = new Set(linkIds);
    this._applyRawPatch((next, infoNext, vocabs) => {
      this._showMorphemes(infoNext, creates);
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
          over
            .filter((w) => w.layerId === sl.id)
            .forEach((w) => {
              const s = (sl.spans || []).find((x) => x.id === w.spanId);
              if (!s) return;
              s.value = w.value;
              if (w.metadata) s.metadata = mergeMetadata(s.metadata, w.metadata);
            });
          fresh
            .filter((w) => w.layerId === sl.id)
            .forEach((w) => {
              if (!Array.isArray(sl.spans)) sl.spans = [];
              sl.spans.push({
                id: w.id,
                tokens: [w.targetId],
                value: w.value,
                ...(w.metadata ? { metadata: w.metadata } : {}),
              });
            });
        });
      }
      Object.values(vocabs || {}).forEach((vocab) => {
        (vocab.vocabLinks || []).forEach((l) => {
          if (linkSet.has(l.id)) l.metadata = mergeMetadata(l.metadata, confirm);
        });
      });
    });

    // An accept that adopts a guess is a guess adoption in the audit log. One
    // that only confirms what is stored is a review.
    return this._queueWrite(
      label,
      async () => {
        // One batch: the morphemes an adopted guess needs, and the spans on
        // them, which name them by the batch's reference to their ids.
        const ids = new Map();
        let morphemes;
        const results = await this._client.batched(async (b) => {
          morphemes = this._queueMorphemes(b, creates);
          tokenIds.forEach((id) => b.tokens.patchMetadata(settledId(id), confirmOps));
          linkIds.forEach((id) => b.vocabLinks.patchMetadata(settledId(id), confirmOps));
          spanIds.forEach((id) => b.spans.patchMetadata(settledId(id), confirmOps));
          over.forEach((w) => {
            b.spans.update(settledId(w.spanId), w.value);
            if (w.metadata) b.spans.patchMetadata(settledId(w.spanId), metadataOps(w.metadata));
          });
          fresh.forEach((w) =>
            b.spans.create(
              w.layerId,
              [morphemes.tokenRef(w.targetId)],
              w.value,
              w.metadata || undefined,
              undefined,
              { id: w.id },
            ),
          );
        });
        morphemes.read(results, ids);
        // The span creates are the batch's last ops, in the order queued.
        const offset = results.length - fresh.length;
        fresh.forEach((w, i) => ids.set(w.id, createdId(results[offset + i])));
        this._settle(ids);
      },
      undefined,
      { kind: live.length ? 'guess-adoption' : 'review' },
    );
  },
};
