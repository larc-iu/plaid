import { useMemo } from 'react';
import { getUdLayerInfo } from '../../../utils/udLayerUtils.js';

export const useSentenceData = (document) => {
  return useMemo(() => {
    if (!document) return [];

    const {
      textLayer,
      tokenLayer,
      lemmaLayer,
      uposLayer,
      xposLayer,
      featuresLayer,
      sentenceLayer,
      mwtLayer,
      relationLayer
    } = getUdLayerInfo(document);

    const text = textLayer?.text;
    const tokens = tokenLayer?.tokens || [];

    if (!text?.body || tokens.length === 0) {
      return [];
    }

    const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);

    const sentenceSpans = sentenceLayer?.spans || [];
    const sentenceStartTokenIds = new Set(
      sentenceSpans
        .map(span => (span.tokens && span.tokens.length > 0 ? span.tokens[0] : span.begin))
        .filter(id => id != null)
    );

    const tokenSentences = [];
    let currentSentence = [];

    for (const token of sortedTokens) {
      if (sentenceStartTokenIds.has(token.id) && currentSentence.length > 0) {
        tokenSentences.push(currentSentence);
        currentSentence = [];
      }
      currentSentence.push(token);
    }

    if (currentSentence.length > 0) {
      tokenSentences.push(currentSentence);
    }

    if (tokenSentences.length === 0 && sortedTokens.length > 0) {
      tokenSentences.push(sortedTokens);
    }

    const buildSpanIndex = (layer) => {
      if (!layer?.spans) return new Map();
      const index = new Map();
      layer.spans.forEach(span => {
        const spanTokens = Array.isArray(span.tokens) && span.tokens.length > 0
          ? span.tokens
          : [span.begin];
        spanTokens
          .filter(tokenId => tokenId != null)
          .forEach(tokenId => {
            if (!index.has(tokenId)) {
              index.set(tokenId, []);
            }
            index.get(tokenId).push(span);
          });
      });
      return index;
    };

    const lemmaIndex = buildSpanIndex(lemmaLayer);
    const uposIndex = buildSpanIndex(uposLayer);
    const xposIndex = buildSpanIndex(xposLayer);
    const featuresIndex = buildSpanIndex(featuresLayer);
    const mwtIndex = buildSpanIndex(mwtLayer);

    const relationList = relationLayer?.relations || [];

    const getAnnotationsForToken = (tokenId) => {
      const lemmaSpans = lemmaIndex.get(tokenId) || [];
      const uposSpans = uposIndex.get(tokenId) || [];
      const xposSpans = xposIndex.get(tokenId) || [];
      const featureSpans = featuresIndex.get(tokenId) || [];
      const mwtSpans = mwtIndex.get(tokenId) || [];

      return {
        lemma: lemmaSpans[0] || null,
        upos: uposSpans[0] || null,
        xpos: xposSpans[0] || null,
        feats: featureSpans.filter(span => span.value),
        mwt: mwtSpans[0] || null
      };
    };

    const getRelationsForSentence = (sentenceTokens) => {
      if (!lemmaLayer?.spans || relationList.length === 0) return [];

      const sentenceTokenIds = new Set(sentenceTokens.map(t => t.id));
      const sentenceLemmaSpans = lemmaLayer.spans.filter(span => {
        const spanTokens = Array.isArray(span.tokens) && span.tokens.length > 0
          ? span.tokens
          : [span.begin];
        return spanTokens.some(tokenId => sentenceTokenIds.has(tokenId));
      });

      const sentenceLemmaSpanIds = new Set(sentenceLemmaSpans.map(span => span.id));
      return relationList.filter(rel => sentenceLemmaSpanIds.has(rel.source));
    };

    const getLemmaSpansForSentence = (sentenceTokens) => {
      if (!lemmaLayer?.spans) return [];
      const sentenceTokenIds = new Set(sentenceTokens.map(t => t.id));
      return lemmaLayer.spans.filter(span => {
        const spanTokens = Array.isArray(span.tokens) && span.tokens.length > 0
          ? span.tokens
          : [span.begin];
        return spanTokens.some(tokenId => sentenceTokenIds.has(tokenId));
      });
    };

    const getMwtSpansForSentence = (sentenceTokens) => {
      if (!mwtLayer?.spans) return [];
      const sentenceTokenIds = new Set(sentenceTokens.map(t => t.id));
      return mwtLayer.spans.filter(span => {
        const spanTokens = Array.isArray(span.tokens) && span.tokens.length > 0
          ? span.tokens
          : [span.begin];
        return spanTokens.some(tokenId => sentenceTokenIds.has(tokenId));
      });
    };

    return tokenSentences.map((sentenceTokens, index) => {
      const processedTokens = sentenceTokens.map((token, tokenIndex) => {
        const tokenForm = text.body.substring(token.begin, token.end);
        const annotations = getAnnotationsForToken(token.id);

        return {
          token,
          tokenForm,
          lemma: annotations.lemma,
          upos: annotations.upos,
          xpos: annotations.xpos,
          feats: annotations.feats,
          mwt: annotations.mwt,
          spanIds: {
            lemma: annotations.lemma?.id || null,
            upos: annotations.upos?.id || null,
            xpos: annotations.xpos?.id || null,
            features: annotations.feats.map(span => ({ value: span.value, spanId: span.id })),
            mwt: annotations.mwt?.id || null
          },
          tokenIndex: tokenIndex + 1
        };
      });

      return {
        id: index,
        text: sentenceTokens
          .map(token => text.body.substring(token.begin, token.end))
          .join(' '),
        tokens: processedTokens,
        relations: getRelationsForSentence(sentenceTokens),
        lemmaSpans: getLemmaSpansForSentence(sentenceTokens),
        mwtSpans: getMwtSpansForSentence(sentenceTokens)
      };
    });
  }, [document]);
};
