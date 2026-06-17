// What a word-token delete destroys, counted across ALL apps' layers.
//
// The server cascade takes the word token plus every token in layers nested
// (transitively) under the word layer and contained in the word's extent —
// IGT's morphemes AND other apps' layers (e.g. UD's syntactic words) — and
// with them every span, every relation grounded on those spans, and every
// vocab link. Much of that is invisible in this editor, so deletion is gated
// on this count: zero -> instant delete (the high-frequency mid-tokenization
// case), nonzero -> a confirm dialog naming what dies. Deletion is FINAL —
// the old undo-snapshot only restored IGT's own layers, which silently lost
// other apps' material while reporting success.

const containsToken = (parent, child) =>
  parent.begin <= child.begin && child.end <= parent.end && child.begin < parent.end;

/**
 * Count the annotations deleting `word` would cascade away.
 *
 * @param {object} layerInfo  getIgtLayerInfo result (primaryTextLayer retains
 *   the FULL tokenLayers list, other apps' layers included)
 * @param {object} vocabularies  the doc's vocabularies map (links live there,
 *   not on the document's token layers)
 * @param {object} word  the word token {id, begin, end}
 * @returns {{annotations: number, links: number}} spans + relations, and vocab links
 */
export const countAnnotationLossForWord = (layerInfo, vocabularies, word) => {
  const result = { annotations: 0, links: 0 };
  const wordLayer = layerInfo?.primaryTokenLayer;
  if (!wordLayer || !word) return result;
  const tokenLayers = layerInfo.primaryTextLayer?.tokenLayers || [];

  // Token layers nested (transitively) under the word layer — these cascade.
  const childrenOf = new Map();
  tokenLayers.forEach(tl => {
    if (tl.parentTokenLayer) {
      if (!childrenOf.has(tl.parentTokenLayer)) childrenOf.set(tl.parentTokenLayer, []);
      childrenOf.get(tl.parentTokenLayer).push(tl);
    }
  });
  const cascading = [];
  const queue = [wordLayer.id];
  while (queue.length) {
    const id = queue.shift();
    for (const child of childrenOf.get(id) || []) {
      cascading.push(child);
      queue.push(child.id);
    }
  }

  // Every token the cascade deletes.
  const dyingTokens = new Set([word.id]);
  for (const tl of cascading) {
    (tl.tokens || []).forEach(t => { if (containsToken(word, t)) dyingTokens.add(t.id); });
  }

  // Spans on dying tokens (any app's), then relations grounded on dying spans
  // (e.g. UD dependencies on its Lemma spans).
  const dyingSpans = new Set();
  for (const tl of [wordLayer, ...cascading]) {
    for (const sl of tl.spanLayers || []) {
      for (const s of sl.spans || []) {
        if (Array.isArray(s.tokens) && s.tokens.some(t => dyingTokens.has(t))) {
          result.annotations += 1;
          dyingSpans.add(s.id);
        }
      }
      for (const rl of sl.relationLayers || []) {
        for (const r of rl.relations || []) {
          if (dyingSpans.has(r.source) || dyingSpans.has(r.target)) result.annotations += 1;
        }
      }
    }
  }

  // Vocab links (IGT keeps them on the vocab table, not the document).
  for (const vocab of Object.values(vocabularies || {})) {
    for (const link of vocab.vocabLinks || []) {
      if (Array.isArray(link.tokens) && link.tokens.some(t => dyingTokens.has(t))) {
        result.links += 1;
      }
    }
  }
  return result;
};

/**
 * Count the annotation loss a SPLIT or MERGE of the given word token(s) causes.
 *
 * Split/merge delete the words' coincident morphemes (and anything nested under
 * them) in the same batch, cascade-deleting their morpheme-scope spans /
 * relations / vocab links. Word-scope spans are NOT lost — split resizes the
 * word in place, merge reparents word spans onto the survivor — so unlike
 * countAnnotationLossForWord this counts ONLY sub-word (morpheme and deeper)
 * material, the work that actually disappears with no warning.
 *
 * @param {object} layerInfo  getIgtLayerInfo result
 * @param {object} vocabularies  the doc's vocabularies map
 * @param {object[]} words  the affected word token(s) [{id, begin, end}, …]
 * @returns {{annotations: number, links: number}}
 */
export const countSubWordAnnotationLoss = (layerInfo, vocabularies, words) => {
  const result = { annotations: 0, links: 0 };
  const wordLayer = layerInfo?.primaryTokenLayer;
  const list = (words || []).filter(Boolean);
  if (!wordLayer || list.length === 0) return result;
  const tokenLayers = layerInfo.primaryTextLayer?.tokenLayers || [];

  // Token layers nested (transitively) UNDER the word layer (morpheme + deeper);
  // the word layer itself is excluded — its spans survive split/merge.
  const childrenOf = new Map();
  tokenLayers.forEach(tl => {
    if (tl.parentTokenLayer) {
      if (!childrenOf.has(tl.parentTokenLayer)) childrenOf.set(tl.parentTokenLayer, []);
      childrenOf.get(tl.parentTokenLayer).push(tl);
    }
  });
  const cascading = [];
  const queue = [wordLayer.id];
  while (queue.length) {
    const id = queue.shift();
    for (const child of childrenOf.get(id) || []) {
      cascading.push(child);
      queue.push(child.id);
    }
  }

  // Sub-word tokens contained in any of the affected words (their morphemes etc.).
  const dyingTokens = new Set();
  for (const tl of cascading) {
    (tl.tokens || []).forEach(t => {
      if (list.some(w => containsToken(w, t))) dyingTokens.add(t.id);
    });
  }
  if (dyingTokens.size === 0) return result;

  const dyingSpans = new Set();
  for (const tl of cascading) {
    for (const sl of tl.spanLayers || []) {
      for (const s of sl.spans || []) {
        if (Array.isArray(s.tokens) && s.tokens.some(t => dyingTokens.has(t))) {
          result.annotations += 1;
          dyingSpans.add(s.id);
        }
      }
      for (const rl of sl.relationLayers || []) {
        for (const r of rl.relations || []) {
          if (dyingSpans.has(r.source) || dyingSpans.has(r.target)) result.annotations += 1;
        }
      }
    }
  }
  for (const vocab of Object.values(vocabularies || {})) {
    for (const link of vocab.vocabLinks || []) {
      if (Array.isArray(link.tokens) && link.tokens.some(t => dyingTokens.has(t))) {
        result.links += 1;
      }
    }
  }
  return result;
};
