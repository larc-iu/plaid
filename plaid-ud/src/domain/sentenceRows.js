import { cpLength, cpSlicer } from '@larc-iu/plaid-client';

// The annotation grid's row model: the sentence > word > morpheme hierarchy,
// with every annotation span already attached to its morpheme.
//
// A pure function of the document body and its layer info, which is why it is
// here and not on ConlluDocument: it reads no instance state and writes none.
// The document caches what it returns against `_dataVersion` (see `sentences`).

const byPosition = (a, b) =>
  a.begin - b.begin || a.end - b.end || (a.precedence ?? 0) - (b.precedence ?? 0);

const buildSpanIndex = (layer) => {
  const index = new Map();
  (layer?.spans || []).forEach((span) => {
    const spanTokens = Array.isArray(span.tokens) ? span.tokens : [];
    spanTokens
      .filter((tokenId) => tokenId != null)
      .forEach((tokenId) => {
        if (!index.has(tokenId)) index.set(tokenId, []);
        index.get(tokenId).push(span);
      });
  });
  return index;
};

// The members of `sorted` (sorted by begin) that `parent` contains, in their
// order. Containment (`containsToken`) asks parent.begin <= begin < parent.end,
// so those are one run of the sorted list, found by binary search, and only
// that run is tested for its end. A filter of the whole list for every parent
// was quadratic: a 21,000-word document spent a minute here.
export const tokensWithin = (sorted, parent) => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid].begin < parent.begin) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < sorted.length && sorted[i].begin < parent.end; i++) {
    if (sorted[i].end <= parent.end) out.push(sorted[i]);
  }
  return out;
};

// A word another app made (igt's Tokenize, an import into it) has no UD word
// under it until a writer opens the document and the repair on open seeds one
// (ConlluDocument._reconcile). A reader never seeds, and neither does an
// export. So every row stands in for the seed: the word gets the one 1:1 UD
// word the seed would make, under an id that is no token's, with no
// annotation. The grid, the export and a reader's view then show the words a
// writer's open shows, and nothing is written.
const VIRTUAL = 'virtual:';

/** Whether a row's word id is a stand-in for a word that has no UD word yet. */
export const isVirtualWordId = (id) => typeof id === 'string' && id.startsWith(VIRTUAL);

const virtualWord = (word) => ({
  id: `${VIRTUAL}${word.id}`,
  begin: word.begin,
  end: word.end,
  precedence: 0,
});

/** The sentence rows for a document body under the given layer info. */
export function buildSentenceRows(body, layerInfo) {
  if (!body) return [];

  const {
    sentenceTokenLayer,
    wordTokenLayer,
    morphemeTokenLayer,
    formLayer,
    lemmaLayer,
    uposLayer,
    xposLayer,
    featuresLayer,
    relationLayer,
    enhancedRelationLayer,
  } = layerInfo;

  const sentenceTokens = [...(sentenceTokenLayer?.tokens || [])].sort(byPosition);
  const wordTokens = [...(wordTokenLayer?.tokens || [])].sort(byPosition);
  const morphemeTokens = [...(morphemeTokenLayer?.tokens || [])].sort(byPosition);

  if (!morphemeTokenLayer) return [];

  // One code-point spread of the body for every slice below. `cpSlice`
  // spreads the whole body per call.
  const slice = cpSlicer(body);

  const formIndex = buildSpanIndex(formLayer);
  const lemmaIndex = buildSpanIndex(lemmaLayer);
  const uposIndex = buildSpanIndex(uposLayer);
  const xposIndex = buildSpanIndex(xposLayer);
  const featuresIndex = buildSpanIndex(featuresLayer);

  const relationList = relationLayer?.relations || [];
  // The enhanced layer's rows, extras and suppressors alike, kept apart from
  // the tree: everything that reads `relations` reads a tree, one head a word.
  const enhancedList = enhancedRelationLayer?.relations || [];

  const buildMorphemeEntry = (morphemeToken, tokenIndex, word) => {
    const id = morphemeToken.id;
    const substring = slice(morphemeToken.begin, morphemeToken.end);
    const formSpan = (formIndex.get(id) || [])[0] || null;
    const lemma = (lemmaIndex.get(id) || [])[0] || null;
    const upos = (uposIndex.get(id) || [])[0] || null;
    const xpos = (xposIndex.get(id) || [])[0] || null;
    const feats = (featuresIndex.get(id) || []).filter((span) => span.value);

    const tokenForm = formSpan?.value != null && formSpan.value !== '' ? formSpan.value : substring;

    return {
      token: morphemeToken,
      tokenForm,
      form: formSpan,
      lemma,
      upos,
      xpos,
      feats,
      word: word || null,
      wordForm: word ? slice(word.begin, word.end) : tokenForm,
      spanIds: {
        form: formSpan?.id || null,
        lemma: lemma?.id || null,
        upos: upos?.id || null,
        xpos: xpos?.id || null,
        features: feats.map((span) => ({ value: span.value, spanId: span.id })),
      },
      tokenIndex,
    };
  };

  const effectiveSentences =
    sentenceTokens.length > 0 ? sentenceTokens : [{ id: '__all__', begin: 0, end: cpLength(body) }];

  const rows = [];
  const rowsByMorpheme = new Map();

  effectiveSentences.forEach((sentence, sentenceIdx) => {
    const wordsInSentence = tokensWithin(wordTokens, sentence);

    const morphemeEntries = [];
    let tokenIndex = 0;

    if (wordsInSentence.length > 0) {
      wordsInSentence.forEach((word) => {
        const stored = tokensWithin(morphemeTokens, word);
        const wordMorphemes = stored.length > 0 ? stored : [virtualWord(word)];
        wordMorphemes.forEach((morpheme, i) => {
          const entry = buildMorphemeEntry(morpheme, tokenIndex + 1, word);
          if (stored.length === 0) entry.virtual = true;
          entry.isFirstMorphemeOfWord = i === 0;
          entry.wordHasMultipleMorphemes = wordMorphemes.length > 1;
          morphemeEntries.push(entry);
          tokenIndex += 1;
        });
      });
    } else {
      tokensWithin(morphemeTokens, sentence).forEach((morpheme) => {
        const entry = buildMorphemeEntry(morpheme, tokenIndex + 1, null);
        entry.isFirstMorphemeOfWord = true;
        entry.wordHasMultipleMorphemes = false;
        morphemeEntries.push(entry);
        tokenIndex += 1;
      });
    }

    if (morphemeEntries.length === 0) return;

    const rowIndex = rows.length;
    morphemeEntries.forEach((entry) => {
      const id = entry.token.id;
      if (!rowsByMorpheme.has(id)) rowsByMorpheme.set(id, []);
      rowsByMorpheme.get(id).push(rowIndex);
    });

    rows.push({
      id: sentence.id ?? sentenceIdx,
      text: slice(sentence.begin, sentence.end),
      sentenceToken: sentenceTokens.length > 0 ? sentence : null,
      tokens: morphemeEntries,
      relations: [],
      enhancedRelations: [],
      lemmaSpans: [],
    });
  });

  // A row's lemma spans are those on any of its morphemes, and its relations
  // those whose source is one of its lemma spans, each in layer order. One
  // pass over each layer rather than one per sentence.
  const rowsByLemmaSpan = new Map();
  (lemmaLayer?.spans || []).forEach((span) => {
    const spanTokens = Array.isArray(span.tokens) ? span.tokens : [];
    const into = new Set();
    spanTokens.forEach((tokenId) => {
      (rowsByMorpheme.get(tokenId) || []).forEach((i) => into.add(i));
    });
    if (into.size === 0) return;
    into.forEach((i) => rows[i].lemmaSpans.push(span));
    const known = rowsByLemmaSpan.get(span.id);
    rowsByLemmaSpan.set(span.id, known ? [...new Set([...known, ...into])] : [...into]);
  });
  const placeRelations = (list, key) =>
    list.forEach((rel) => {
      (rowsByLemmaSpan.get(rel.source) || []).forEach((i) => rows[i][key].push(rel));
    });
  placeRelations(relationList, 'relations');
  placeRelations(enhancedList, 'enhancedRelations');

  return rows;
}
