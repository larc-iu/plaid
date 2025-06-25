import { useMemo } from 'react';

export const useSentenceData = (document) => {
  return useMemo(() => {
    if (!document) return [];

    const textLayer = document.textLayers?.[0];
    const text = textLayer?.text;
    const tokenLayer = textLayer?.tokenLayers?.[0];
    const tokens = tokenLayer?.tokens || [];
    
    if (!text?.body || tokens.length === 0) {
      return [];
    }

    // Get all span layers
    const spanLayers = tokenLayer?.spanLayers || [];
    const lemmaLayer = spanLayers.find(layer => layer.name === 'Lemma');
    const uposLayer = spanLayers.find(layer => layer.name === 'UPOS');
    const xposLayer = spanLayers.find(layer => layer.name === 'XPOS');
    const featuresLayer = spanLayers.find(layer => layer.name === 'Features');
    const sentenceLayer = spanLayers.find(layer => layer.name === 'Sentence');
    
    // Get relation layer
    const relationLayer = lemmaLayer?.relationLayers?.[0];
    
    // Sort tokens by position in text
    const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);
    
    // Find sentence boundaries
    const sentenceSpans = sentenceLayer?.spans || [];
    const sentenceStartTokenIds = new Set(
      sentenceSpans.map(span => {
        if (span.tokens && span.tokens.length > 0) {
          return span.tokens[0];
        }
        return span.begin;
      }).filter(id => id != null)
    );

    // Group tokens into sentences
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

    // If no sentence boundaries, treat all tokens as one sentence
    if (tokenSentences.length === 0 && sortedTokens.length > 0) {
      tokenSentences.push(sortedTokens);
    }

    // Helper function to get annotations for a token
    const getTokenAnnotations = (tokenId) => {
      const annotations = {
        lemma: null,
        upos: null,
        xpos: null,
        feats: [],
        spanIds: {
          lemma: null,
          upos: null,
          xpos: null,
          features: []
        }
      };

      // Process each layer type
      [
        { layer: lemmaLayer, type: 'lemma' },
        { layer: uposLayer, type: 'upos' },  
        { layer: xposLayer, type: 'xpos' },
        { layer: featuresLayer, type: 'feats' }
      ].forEach(({ layer, type }) => {
        if (!layer?.spans) return;
        
        layer.spans.forEach(span => {
          const spanTokens = span.tokens || [span.begin];
          
          if (spanTokens.includes(tokenId)) {
            if (type === 'feats') {
              // Features can have multiple spans per token
              if (span.value) {
                annotations.feats.push(span);
                annotations.spanIds.features.push({
                  value: span.value,
                  spanId: span.id
                });
              }
            } else {
              // Single value annotations
              annotations[type] = span;
              annotations.spanIds[type] = span.id;
            }
          }
        });
      });

      return annotations;
    };

    // Helper function to get relations for a sentence
    const getRelationsForSentence = (sentenceTokens) => {
      if (!relationLayer?.relations || !lemmaLayer?.spans) return [];
      
      const sentenceTokenIds = new Set(sentenceTokens.map(t => t.id));
      
      // Get lemma spans for tokens in this sentence
      const sentenceLemmaSpans = lemmaLayer.spans.filter(span => {
        const spanTokens = span.tokens || [span.begin];
        return spanTokens.some(tokenId => sentenceTokenIds.has(tokenId));
      });
      
      const sentenceLemmaSpanIds = new Set(sentenceLemmaSpans.map(s => s.id));
      
      // Filter relations to only those involving this sentence's lemma spans
      return relationLayer.relations.filter(rel => 
        sentenceLemmaSpanIds.has(rel.source)
      );
    };

    // Helper function to get lemma spans for a sentence
    const getLemmaSpansForSentence = (sentenceTokens) => {
      if (!lemmaLayer?.spans) return [];
      
      const sentenceTokenIds = new Set(sentenceTokens.map(t => t.id));
      return lemmaLayer.spans.filter(span => {
        const spanTokens = span.tokens || [span.begin];
        return spanTokens.some(tokenId => sentenceTokenIds.has(tokenId));
      });
    };

    // Process each sentence into the final data structure
    return tokenSentences.map((sentenceTokens, index) => {
      const processedTokens = sentenceTokens.map((token, tokenIndex) => {
        const tokenForm = text.body.substring(token.begin, token.end);
        const annotations = getTokenAnnotations(token.id);
        
        return {
          token,
          tokenForm,
          lemma: annotations.lemma,
          upos: annotations.upos,
          xpos: annotations.xpos,
          feats: annotations.feats,
          spanIds: annotations.spanIds,
          tokenIndex: tokenIndex + 1
        };
      });

      return {
        id: index,
        text: sentenceTokens.map(token => 
          text.body.substring(token.begin, token.end)
        ).join(' '),
        tokens: processedTokens,
        relations: getRelationsForSentence(sentenceTokens),
        lemmaSpans: getLemmaSpansForSentence(sentenceTokens)
      };
    });
  }, [document]);
};