// Reconcile-on-open validation for IGT documents.
//
// IGT's editor contract: every morpheme is full-width over its parent word
// (morpheme.begin/end === word begin/end), and every word shows a morpheme
// whether or not one is stored (an unanalyzed word's is synthesized by derive,
// see virtualMorpheme.js). When another app edits the shared substrate, say by
// splitting a word in UD, IGT can come back to find morphemes whose extent matches
// no current word (orphans left by a cascade). The server doesn't know IGT's
// contract, so IGT validates on open and heals.

import { readFieldLang, readVocabFields } from './igtConfig.js';
import { fieldNameLang } from './fieldNames.js';

const extentKey = (t) => `${t.begin}:${t.end}`;

/**
 * The heal plan for a document's morpheme layer: `orphanMorphemeIds`, the
 * morphemes whose extent matches no current word. Delete ALL of them (heal
 * downward; the word tokenization is authoritative). Orphans carrying
 * annotation spans are deleted too: the gloss loss is rare, low-impact, and
 * recoverable via document history (the cascade is audited), and keeping them
 * only left an invisible, immortal, un-actionable token.
 * `deletedAnnotatedOrphans` counts those so the caller can warn loudly.
 *
 * The other half of this plan used to be `wordsNeedingMorpheme`: a word with no
 * morpheme got one written for it on open. It no longer does, because that row
 * held nothing. A default morpheme's extent is its word's extent and its form
 * is its word's text, so `derive` synthesizes it instead and the first write
 * makes it real (see virtualMorpheme.js). What is left here is a true repair:
 * an orphan is a token that exists and should not.
 *
 * Returns an empty list when there is no morpheme layer (e.g. a project set up
 * by another app that IGT has not adopted yet).
 *
 * @param {object} layerInfo result of getIgtLayerInfo (bound layers)
 */
export const planMorphemeReconcile = (layerInfo) => {
  const empty = { orphanMorphemeIds: [], deletedAnnotatedOrphans: 0 };
  if (!layerInfo?.morphemeTokenLayer) return empty;

  const words = layerInfo.primaryTokenLayer?.tokens || [];
  const morphemes = layerInfo.morphemeTokenLayer.tokens || [];
  const wordExtents = new Set(words.map(extentKey));

  // Morpheme token ids carrying at least one annotation span — tracked only so
  // we can REPORT how many annotated orphans we delete (the cascade takes their
  // spans with them). We used to keep annotated orphans to avoid gloss loss, but
  // a kept orphan was invisible and immortal in the editor (matches no word, so
  // never rendered) and thus un-actionable; deleting is recoverable via history.
  const annotated = new Set();
  (layerInfo.spanLayers?.morpheme || []).forEach((sl) =>
    (sl.spans || []).forEach((sp) => (sp.tokens || []).forEach((t) => annotated.add(t))),
  );

  const orphans = morphemes.filter((m) => !wordExtents.has(extentKey(m)));
  const orphanMorphemeIds = orphans.map((m) => m.id);
  const deletedAnnotatedOrphans = orphans.filter((m) => annotated.has(m.id)).length;

  return { orphanMorphemeIds, deletedAnnotatedOrphans };
};

/**
 * Morph-type sync plan: a morpheme linked to a lexicon entry takes the entry's
 * morphType (the entry is the source of truth; the token's metadata.morphType
 * is a cache for unlinked morphemes and for consumers that don't load the
 * lexicon). Every morpheme whose cached type differs from its entry's gets a
 * metadata patch. Entries without a type never override. Takes the DERIVED
 * sentences (morphemes carry `vocabItem` + `metadata`).
 * @returns {Array<{morphemeId: string, morphType: string}>}
 */
export const planMorphTypeSync = (sentences) => {
  const plans = [];
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      for (const m of t.morphemes || []) {
        // The entry's type as derive resolved it (its own, else its
        // headword's), so a hand-made sense syncs its headword's type.
        const fromItem = m.entryMorphType ?? m.vocabItem?.metadata?.morphType;
        if (typeof fromItem !== 'string' || fromItem === '') continue;
        if ((m.metadata?.morphType ?? null) === fromItem) continue;
        plans.push({ morphemeId: m.id, morphType: fromItem });
      }
    }
  }
  return plans;
};

// One layer's dedup plan: at most ONE span per token in a layer (derive.js
// renders the FIRST span per token per layer at EVERY scope, so any extra is
// invisible and immortal). Heal LOSSLESSLY — concatenate the distinct values
// into the first span (' | ') and delete the rest, so everything is visible for
// a human to revise.
const planLayerSpanDedup = (sl, scope) => {
  const plans = [];
  const byToken = new Map();
  for (const sp of sl.spans || []) {
    // IGT annotation spans are single-token by construction; leave anything
    // exotic (multi-token spans) alone.
    if (!Array.isArray(sp.tokens) || sp.tokens.length !== 1) continue;
    const tid = sp.tokens[0];
    if (!byToken.has(tid)) byToken.set(tid, []);
    byToken.get(tid).push(sp);
  }
  byToken.forEach((spans, tokenId) => {
    if (spans.length < 2) return;
    const values = [];
    for (const sp of spans) {
      const v = sp.value == null ? '' : String(sp.value);
      if (v !== '' && !values.includes(v)) values.push(v);
    }
    const mergedValue = values.join(' | ');
    const firstValue = spans[0].value == null ? '' : String(spans[0].value);
    plans.push({
      scope,
      layerId: sl.id,
      layerName: sl.name,
      tokenId,
      keepSpanId: spans[0].id,
      mergedValue,
      needsUpdate: mergedValue !== firstValue,
      deleteSpanIds: spans.slice(1).map((s) => s.id),
    });
  });
  return plans;
};

/**
 * Heal plan for duplicate spans at ANY scope (word / morpheme / sentence).
 * IGT's contract: at most one span per layer per token. Duplicates arise when
 * another app's token merge reparents the dying token's spans onto the survivor
 * (the server's tokens.merge), leaving >1 span the editor can neither show nor
 * edit. Heal losslessly per `planLayerSpanDedup`. Reported loudly by the caller.
 *
 * Returns [{scope, layerId, layerName, tokenId, keepSpanId, mergedValue,
 * needsUpdate, deleteSpanIds}] — one entry per (layer, token) with >1 span.
 */
export const planSpanDedup = (layerInfo) => {
  const buckets = layerInfo?.spanLayers || {};
  return [
    ...(buckets.word || []).flatMap((sl) => planLayerSpanDedup(sl, 'word')),
    ...(buckets.morpheme || []).flatMap((sl) => planLayerSpanDedup(sl, 'morpheme')),
    ...(buckets.sentence || []).flatMap((sl) => planLayerSpanDedup(sl, 'sentence')),
  ];
};

/**
 * Heal plan for tokens carrying more than one single-token vocab link (across
 * all of the project's vocabs). IGT's contract: at most ONE link per token —
 * the popover, derive.js and the level rule all assume it, and linking from a
 * second vocab replaces the first. Duplicates arise exactly like duplicate
 * spans: a token merge reparents the dying token's link onto the survivor
 * (server tokens.merge), leaving a link the editor neither shows nor unlinks.
 *
 * Keep one link per token: a link in `preferLinkIds` when present (the merge
 * passes the survivor's own pre-merge link), else the first one seen; delete
 * the rest. Returns [{tokenId, keepLinkId, deleteLinks: [{vocabId, linkId}]}].
 */
export const planVocabLinkDedup = (vocabularies, preferLinkIds = new Set()) => {
  const byToken = new Map();
  for (const vocab of Object.values(vocabularies || {})) {
    for (const link of vocab.vocabLinks || []) {
      if (!Array.isArray(link.tokens) || link.tokens.length !== 1) continue;
      const tid = link.tokens[0];
      if (!byToken.has(tid)) byToken.set(tid, []);
      byToken.get(tid).push({ vocabId: vocab.id, linkId: link.id });
    }
  }
  const plans = [];
  byToken.forEach((links, tokenId) => {
    if (links.length < 2) return;
    const keep = links.find((l) => preferLinkIds.has(l.linkId)) || links[0];
    plans.push({
      tokenId,
      keepLinkId: keep.linkId,
      deleteLinks: links.filter((l) => l !== keep),
    });
  });
  return plans;
};

// Apply a planVocabLinkDedup plan to a vocabularies map in place (optimistic
// patch mirror of the server deletes).
export const applyVocabLinkDedup = (vocabularies, plans) => {
  for (const p of plans) {
    for (const { vocabId, linkId } of p.deleteLinks) {
      const v = vocabularies?.[vocabId];
      if (v && Array.isArray(v.vocabLinks))
        v.vocabLinks = v.vocabLinks.filter((l) => l.id !== linkId);
    }
  }
};

/**
 * Back-fill of a field's recorded language from its name, once. A field named
 * "Gloss (nl)" by the FLEx importer before the record existed says its
 * language in its name alone, and the exporters no longer read names. Every
 * span layer whose name carries a language-shaped suffix and whose config
 * records none gets that suffix recorded. A field that records a language is
 * left alone, whatever its name says: the record is the fact, the name is
 * how it arrived.
 *
 * @param {Array<{id: string, name: string, config?: object}>} spanLayers
 * @returns {Array<{id: string, lang: string}>}
 */
export function planFieldLangBackfill(spanLayers) {
  const out = [];
  for (const sl of spanLayers || []) {
    if (!sl?.id || readFieldLang(sl.config)) continue;
    const lang = fieldNameLang(sl.name);
    if (lang) out.push({ id: sl.id, lang });
  }
  return out;
}

/**
 * The same for a vocabulary's fields ("gloss (ru)"), whose language sits in
 * the field schema rather than on a layer. Returns the whole schema with the
 * languages filled in, or null when nothing was missing, since the schema is
 * written as one value.
 */
export function planVocabFieldLangBackfill(vocab) {
  const fields = readVocabFields(vocab?.config);
  if (!fields) return null;
  let changed = false;
  const next = {};
  for (const [name, spec] of Object.entries(fields)) {
    const lang = spec?.lang ? null : fieldNameLang(name);
    next[name] = lang ? { ...spec, lang } : spec;
    if (lang) changed = true;
  }
  return changed ? next : null;
}

/**
 * Token layers that have not yet declared which metadata keys survive a split.
 *
 * A token born of a split is otherwise born bare, and provenance lost that way
 * leaves nothing for a later pass to find, so the declaration has to be in
 * place BEFORE the split rather than repaired after it. This is the back-fill
 * step of the reconcile contract: projects made before the declaration existed
 * pick it up the next time a maintainer opens a document.
 *
 * Only what the layer is missing is reported, so this is a no-op on the second
 * open and forever after.
 */
export const planPreserveOnSplit = (layerInfo, namespace, key, wanted) => {
  const layers = [
    layerInfo?.sentenceTokenLayer,
    layerInfo?.primaryTokenLayer,
    layerInfo?.morphemeTokenLayer,
    layerInfo?.alignmentTokenLayer,
  ];
  const out = [];
  for (const layer of layers) {
    if (!layer?.id) continue;
    const declared = layer.config?.[namespace]?.[key];
    const has = Array.isArray(declared) && wanted.every((k) => declared.includes(k));
    if (!has) out.push(layer.id);
  }
  return out;
};
