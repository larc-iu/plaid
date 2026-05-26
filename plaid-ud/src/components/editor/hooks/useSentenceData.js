import { useMemo } from 'react';
import { getUdLayerInfo, containsToken } from '../../../utils/udLayerUtils.js';

// Derive the annotation table from the three-layer token hierarchy
// (sentences > words > morphemes) by character-offset containment.
//
// Each emitted sentence row's `tokens` array holds one entry per MORPHEME
// (the numbered CoNLL-U word rows) — that is where all annotation lives. A word
// with multiple morphemes is a multiword token; its morphemes share the word's
// full extent and are ordered by `precedence`, distinguished by their Form span.
export const useSentenceData = (document) => {
  return useMemo(() => {
    if (!document) return [];

    const {
      textLayer,
      sentenceTokenLayer,
      wordTokenLayer,
      morphemeTokenLayer,
      formLayer,
      lemmaLayer,
      uposLayer,
      xposLayer,
      featuresLayer,
      relationLayer
    } = getUdLayerInfo(document);

    const body = textLayer?.text?.body;
    if (!body) return [];

    const byPosition = (a, b) =>
      (a.begin - b.begin) || (a.end - b.end) || ((a.precedence ?? 0) - (b.precedence ?? 0));

    const sentenceTokens = [...(sentenceTokenLayer?.tokens || [])].sort(byPosition);
    const wordTokens = [...(wordTokenLayer?.tokens || [])].sort(byPosition);
    const morphemeTokens = [...(morphemeTokenLayer?.tokens || [])].sort(byPosition);

    if (morphemeTokens.length === 0) return [];

    // Index every annotation span layer by the morpheme token id it covers.
    const buildSpanIndex = (layer) => {
      const index = new Map();
      (layer?.spans || []).forEach(span => {
        const spanTokens = Array.isArray(span.tokens) ? span.tokens : [];
        spanTokens
          .filter(tokenId => tokenId != null)
          .forEach(tokenId => {
            if (!index.has(tokenId)) index.set(tokenId, []);
            index.get(tokenId).push(span);
          });
      });
      return index;
    };

    const formIndex = buildSpanIndex(formLayer);
    const lemmaIndex = buildSpanIndex(lemmaLayer);
    const uposIndex = buildSpanIndex(uposLayer);
    const xposIndex = buildSpanIndex(xposLayer);
    const featuresIndex = buildSpanIndex(featuresLayer);

    const relationList = relationLayer?.relations || [];

    // Half-open containment: see `containsToken` in udLayerUtils. Zero-width
    // children at `parent.end` correctly attach to the right-side parent only.
    const contains = containsToken;

    const buildMorphemeEntry = (morphemeToken, tokenIndex, word) => {
      const id = morphemeToken.id;
      const substring = body.substring(morphemeToken.begin, morphemeToken.end);
      const formSpan = (formIndex.get(id) || [])[0] || null;
      const lemma = (lemmaIndex.get(id) || [])[0] || null;
      const upos = (uposIndex.get(id) || [])[0] || null;
      const xpos = (xposIndex.get(id) || [])[0] || null;
      const feats = (featuresIndex.get(id) || []).filter(span => span.value);

      const tokenForm = (formSpan?.value != null && formSpan.value !== '') ? formSpan.value : substring;

      return {
        token: morphemeToken,
        tokenForm,
        form: formSpan,
        lemma,
        upos,
        xpos,
        feats,
        word: word || null,
        wordForm: word ? body.substring(word.begin, word.end) : tokenForm,
        spanIds: {
          form: formSpan?.id || null,
          lemma: lemma?.id || null,
          upos: upos?.id || null,
          xpos: xpos?.id || null,
          features: feats.map(span => ({ value: span.value, spanId: span.id }))
        },
        tokenIndex
      };
    };

    // Group morphemes into sentence rows: sentence > word > morpheme.
    const effectiveSentences = sentenceTokens.length > 0
      ? sentenceTokens
      : [{ id: '__all__', begin: 0, end: body.length }];

    const rows = [];

    effectiveSentences.forEach((sentence, sentenceIdx) => {
      const wordsInSentence = wordTokens.filter(word => contains(sentence, word));

      const morphemeEntries = [];
      let tokenIndex = 0;

      if (wordsInSentence.length > 0) {
        wordsInSentence.forEach(word => {
          const wordMorphemes = morphemeTokens.filter(m => contains(word, m));
          wordMorphemes.forEach((morpheme, i) => {
            const entry = buildMorphemeEntry(morpheme, tokenIndex + 1, word);
            entry.isFirstMorphemeOfWord = i === 0;
            entry.wordHasMultipleMorphemes = wordMorphemes.length > 1;
            morphemeEntries.push(entry);
            tokenIndex += 1;
          });
        });
      } else {
        // No word layer yet — fall back to morphemes directly under the sentence.
        morphemeTokens.filter(m => contains(sentence, m)).forEach(morpheme => {
          const entry = buildMorphemeEntry(morpheme, tokenIndex + 1, null);
          entry.isFirstMorphemeOfWord = true;
          entry.wordHasMultipleMorphemes = false;
          morphemeEntries.push(entry);
          tokenIndex += 1;
        });
      }

      if (morphemeEntries.length === 0) return;

      const morphemeIds = new Set(morphemeEntries.map(entry => entry.token.id));

      const sentenceLemmaSpans = (lemmaLayer?.spans || []).filter(span => {
        const spanTokens = Array.isArray(span.tokens) ? span.tokens : [];
        return spanTokens.some(tokenId => morphemeIds.has(tokenId));
      });
      const sentenceLemmaSpanIds = new Set(sentenceLemmaSpans.map(span => span.id));
      const relations = relationList.filter(rel => sentenceLemmaSpanIds.has(rel.source));

      rows.push({
        id: sentence.id ?? sentenceIdx,
        text: body.substring(sentence.begin, sentence.end),
        sentenceToken: sentenceTokens.length > 0 ? sentence : null,
        tokens: morphemeEntries,
        relations,
        lemmaSpans: sentenceLemmaSpans
      });
    });

    return rows;
  }, [document]);
};
