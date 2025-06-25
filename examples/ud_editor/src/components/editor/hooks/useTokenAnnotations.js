import { useMemo } from 'react';

export const useTokenAnnotations = (document) => {
  return useMemo(() => {
    const getTokenAnnotations = (tokenId) => {
      const textLayer = document?.textLayers?.[0];
      const tokenLayer = textLayer?.tokenLayers?.[0];
      const spanLayers = tokenLayer?.spanLayers || [];
      
      const annotations = {
        lemma: null,
        upos: null,
        xpos: null,
        features: [],
        spanIds: {
          lemma: null,
          upos: null,
          xpos: null,
          features: []  // Array of {value, spanId} objects
        }
      };

      // Find spans for each annotation type
      spanLayers.forEach(layer => {
        const spans = layer.spans || [];
        
        spans.forEach(span => {
          const spanTokens = span.tokens || [span.begin];
          
          if (spanTokens.includes(tokenId)) {
            switch (layer.name) {
              case 'Lemma':
                annotations.lemma = span.value;
                annotations.spanIds.lemma = span.id;
                break;
              case 'UPOS':
                annotations.upos = span.value;
                annotations.spanIds.upos = span.id;
                break;
              case 'XPOS':
                annotations.xpos = span.value;
                annotations.spanIds.xpos = span.id;
                break;
              case 'Features':
                // Features can have multiple spans per token
                if (span.value) {
                  annotations.features.push(span.value);
                  annotations.spanIds.features.push({
                    value: span.value,
                    spanId: span.id
                  });
                }
                break;
            }
          }
        });
      });

      return annotations;
    };

    return getTokenAnnotations;
  }, [document]);
};