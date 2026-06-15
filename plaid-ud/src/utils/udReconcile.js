// Reconcile-on-open validation for UD documents.
//
// UD's formalism forbids a dependency relation from crossing a sentence
// boundary. The server doesn't (and shouldn't) know this app-specific rule, so
// when another app edits the shared substrate — e.g. splits a sentence in the
// IGT editor — a UD relation that used to sit inside one sentence can end up
// straddling two. We can't catch that while UD is closed; instead UD validates
// on open and heals.
//
// This generalizes the single-split "crossing" check inside
// ConlluDocument.toggleSentenceBoundary to the whole current sentence partition.

/**
 * IDs of dependency relations whose two endpoints lie in different sentences
 * (i.e. they cross a sentence boundary). Root self-loops are ignored, and an
 * endpoint that can't be resolved to a sentence is left alone (conservative —
 * same behaviour as the edit-time check). Heal by deleting these relations:
 * heal downward toward the substrate, never move the sentence.
 *
 * @param {object} layerInfo the result of getUdLayerInfo (bound layers)
 * @returns {string[]} relation ids to delete
 */
export const interSententialRelationIds = (layerInfo) => {
  const sentenceTokens = layerInfo?.sentenceTokenLayer?.tokens || [];
  const morphemeTokens = layerInfo?.morphemeTokenLayer?.tokens || [];
  const lemmaSpans = layerInfo?.lemmaLayer?.spans || [];
  const relations = layerInfo?.relationLayer?.relations || [];
  if (!relations.length || !sentenceTokens.length) return [];

  // A begin offset falls in exactly one sentence (the sentence layer is
  // partitioning). Sort once by begin and binary-search each lookup, so the whole
  // pass is O(n log n) rather than O(spans × sentences) on the document-open path.
  const sortedSentences = [...sentenceTokens].sort((a, b) => a.begin - b.begin);
  const sentenceIdAt = (begin) => {
    if (begin == null) return null;
    let lo = 0, hi = sortedSentences.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = sortedSentences[mid];
      if (begin < s.begin) hi = mid - 1;
      else if (begin >= s.end) lo = mid + 1;
      else return s.id;
    }
    return null;
  };

  const beginByMorpheme = new Map(morphemeTokens.map(t => [t.id, t.begin]));
  const sentenceIdByLemmaSpan = new Map();
  lemmaSpans.forEach(span => {
    const tid = Array.isArray(span.tokens) && span.tokens.length > 0 ? span.tokens[0] : null;
    const begin = tid != null ? beginByMorpheme.get(tid) : null;
    sentenceIdByLemmaSpan.set(span.id, sentenceIdAt(begin));
  });

  return relations
    .filter(rel => {
      if (rel.source === rel.target) return false; // root self-loop
      const s = sentenceIdByLemmaSpan.get(rel.source);
      const t = sentenceIdByLemmaSpan.get(rel.target);
      if (s == null || t == null) return false; // unresolvable — leave it alone
      return s !== t; // different sentences -> crosses a boundary
    })
    .map(rel => rel.id);
};

/**
 * Extents of words that lack a full-width syntactic-word ("morpheme") token.
 *
 * UD annotations live on the syntactic-word layer, and the grid is built from
 * those tokens — so a word with no syntactic-word is invisible and
 * unannotatable. Another app (e.g. IGT) can create orthographic words on the
 * shared substrate without UD's syntactic-word layer, leaving words "bare".
 * This is the symmetric counterpart to IGT's "every word ≥1 morpheme" heal:
 * UD seeds one default full-width syntactic-word per bare word on open.
 *
 * Coverage is by exact extent: a syntactic-word always spans its parent word's
 * full [begin, end) (the full-width rule), and words are non-overlapping, so an
 * extent key maps a word to its syntactic-words 1:1. A word is "bare" iff no
 * syntactic-word shares its extent.
 *
 * @param {object} layerInfo the result of getUdLayerInfo (bound layers)
 * @returns {Array<{begin:number,end:number}>} extents needing a syntactic-word
 */
export const wordsNeedingSyntacticWord = (layerInfo) => {
  const wordTokens = layerInfo?.wordTokenLayer?.tokens || [];
  const morphemeTokens = layerInfo?.morphemeTokenLayer?.tokens || [];
  if (!wordTokens.length) return [];

  const covered = new Set(morphemeTokens.map(m => `${m.begin}:${m.end}`));
  return wordTokens
    .filter(w => !covered.has(`${w.begin}:${w.end}`))
    .map(w => ({ begin: w.begin, end: w.end }));
};

/**
 * Syntactic-word ("morpheme") tokens whose extent matches no word — the
 * symmetric counterpart to wordsNeedingSyntacticWord. They arise when another
 * app changes word boundaries (e.g. merges two words) without UD's full-width
 * syntactic-words following: each old full-width token is now CONTAINED in the
 * merged word but spans no single word (the server enforces only containment,
 * not extent equality), so the grid renders it as a spurious extra morpheme.
 * Heal downward (the word tokenization is authoritative): delete them. The
 * delete cascades their UD spans + relations server-side — rare, low-impact, and
 * recoverable via document history. `annotatedCount` reports how many carried
 * annotation spans so the caller can warn loudly.
 *
 * MWT morphemes legitimately share their word's extent, so an extent that
 * matches a word is never an orphan, no matter how many morphemes share it.
 *
 * @param {object} layerInfo the result of getUdLayerInfo (bound layers)
 * @returns {{ids: string[], annotatedCount: number}}
 */
export const orphanSyntacticWords = (layerInfo) => {
  const wordTokens = layerInfo?.wordTokenLayer?.tokens || [];
  const morphemeTokens = layerInfo?.morphemeTokenLayer?.tokens || [];
  if (!morphemeTokens.length) return { ids: [], annotatedCount: 0 };

  const wordExtents = new Set(wordTokens.map(w => `${w.begin}:${w.end}`));
  const orphans = morphemeTokens.filter(m => !wordExtents.has(`${m.begin}:${m.end}`));

  const annotated = new Set();
  [layerInfo.formLayer, layerInfo.lemmaLayer, layerInfo.uposLayer, layerInfo.xposLayer, layerInfo.featuresLayer]
    .filter(Boolean)
    .forEach(sl => (sl.spans || []).forEach(sp => (sp.tokens || []).forEach(t => annotated.add(t))));

  return {
    ids: orphans.map(m => m.id),
    annotatedCount: orphans.filter(m => annotated.has(m.id)).length,
  };
};

// One single-valued span layer's dedup plan: at most ONE span per morpheme (the
// grid renders the first per field), so any extra is invisible + immortal. Heal
// losslessly — concatenate distinct values into the first span (' | ') and
// delete the rest, so a human can revise the joined value.
const planLayerSpanDedup = (layer, field) => {
  const plans = [];
  if (!layer) return plans;
  const byToken = new Map();
  for (const sp of layer.spans || []) {
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
      field,
      layerId: layer.id,
      tokenId,
      keepSpanId: spans[0].id,
      mergedValue,
      needsUpdate: mergedValue !== firstValue,
      deleteSpanIds: spans.slice(1).map(s => s.id),
    });
  });
  return plans;
};

/**
 * Heal plan for duplicate single-valued spans on a morpheme. UD's single-valued
 * fields are Form / Lemma / UPOS / XPOS (Features are intentionally many-per-
 * token, so they are EXCLUDED). Duplicates arise when a token merge in another
 * app reparents the dying token's spans onto the survivor. Heal per
 * planLayerSpanDedup.
 *
 * @param {object} layerInfo the result of getUdLayerInfo (bound layers)
 * @returns {Array} dedup plans (one per layer+token with >1 span)
 */
export const planSpanDedup = (layerInfo) => [
  ...planLayerSpanDedup(layerInfo?.formLayer, 'form'),
  ...planLayerSpanDedup(layerInfo?.lemmaLayer, 'lemma'),
  ...planLayerSpanDedup(layerInfo?.uposLayer, 'upos'),
  ...planLayerSpanDedup(layerInfo?.xposLayer, 'xpos'),
];

/**
 * Lemma spans that are the TARGET of more than one (non-root) dependency
 * relation — i.e. a node with more than one head. UD allows exactly one head
 * per node; createRelation enforces it, so duplicates come only from another
 * app or a data anomaly. We cannot know which head is correct, so this is
 * REPORTED (not healed) — the validator surfaces it for a human to resolve.
 *
 * @param {object} layerInfo the result of getUdLayerInfo (bound layers)
 * @returns {Array<{target: string, count: number}>}
 */
export const multiHeadTargets = (layerInfo) => {
  const relations = (layerInfo?.relationLayer?.relations || []).filter(r => r.source !== r.target);
  const counts = new Map();
  relations.forEach(r => counts.set(r.target, (counts.get(r.target) || 0) + 1));
  return [...counts.entries()].filter(([, n]) => n > 1).map(([target, count]) => ({ target, count }));
};
