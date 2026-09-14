import { cpLength, cpSlice } from '@larc-iu/plaid-client';
import { containsToken } from '../utils/udLayerUtils.js';

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
  } = layerInfo;

  const sentenceTokens = [...(sentenceTokenLayer?.tokens || [])].sort(byPosition);
  const wordTokens = [...(wordTokenLayer?.tokens || [])].sort(byPosition);
  const morphemeTokens = [...(morphemeTokenLayer?.tokens || [])].sort(byPosition);

  if (morphemeTokens.length === 0) return [];

  const formIndex = buildSpanIndex(formLayer);
  const lemmaIndex = buildSpanIndex(lemmaLayer);
  const uposIndex = buildSpanIndex(uposLayer);
  const xposIndex = buildSpanIndex(xposLayer);
  const featuresIndex = buildSpanIndex(featuresLayer);

  const relationList = relationLayer?.relations || [];

  const buildMorphemeEntry = (morphemeToken, tokenIndex, word) => {
    const id = morphemeToken.id;
    const substring = cpSlice(body, morphemeToken.begin, morphemeToken.end);
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
      wordForm: word ? cpSlice(body, word.begin, word.end) : tokenForm,
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

  effectiveSentences.forEach((sentence, sentenceIdx) => {
    const wordsInSentence = wordTokens.filter((word) => containsToken(sentence, word));

    const morphemeEntries = [];
    let tokenIndex = 0;

    if (wordsInSentence.length > 0) {
      wordsInSentence.forEach((word) => {
        const wordMorphemes = morphemeTokens.filter((m) => containsToken(word, m));
        wordMorphemes.forEach((morpheme, i) => {
          const entry = buildMorphemeEntry(morpheme, tokenIndex + 1, word);
          entry.isFirstMorphemeOfWord = i === 0;
          entry.wordHasMultipleMorphemes = wordMorphemes.length > 1;
          morphemeEntries.push(entry);
          tokenIndex += 1;
        });
      });
    } else {
      morphemeTokens
        .filter((m) => containsToken(sentence, m))
        .forEach((morpheme) => {
          const entry = buildMorphemeEntry(morpheme, tokenIndex + 1, null);
          entry.isFirstMorphemeOfWord = true;
          entry.wordHasMultipleMorphemes = false;
          morphemeEntries.push(entry);
          tokenIndex += 1;
        });
    }

    if (morphemeEntries.length === 0) return;

    const morphemeIds = new Set(morphemeEntries.map((entry) => entry.token.id));

    const sentenceLemmaSpans = (lemmaLayer?.spans || []).filter((span) => {
      const spanTokens = Array.isArray(span.tokens) ? span.tokens : [];
      return spanTokens.some((tokenId) => morphemeIds.has(tokenId));
    });
    const sentenceLemmaSpanIds = new Set(sentenceLemmaSpans.map((span) => span.id));
    const relations = relationList.filter((rel) => sentenceLemmaSpanIds.has(rel.source));

    rows.push({
      id: sentence.id ?? sentenceIdx,
      text: cpSlice(body, sentence.begin, sentence.end),
      sentenceToken: sentenceTokens.length > 0 ? sentence : null,
      tokens: morphemeEntries,
      relations,
      lemmaSpans: sentenceLemmaSpans,
    });
  });

  return rows;
}
