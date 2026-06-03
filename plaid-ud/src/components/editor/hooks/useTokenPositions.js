import { useState, useCallback, useRef, useEffect } from 'react';

// Compare two measured-position arrays for arc-geometry equivalence. Token
// objects get fresh identities on every doc rebuild, so compare the fields that
// actually drive arc rendering (token id + x/y/width/index/lemmaSpanId).
const samePositions = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    if (p.x !== q.x || p.y !== q.y || p.width !== q.width ||
        p.index !== q.index || p.lemmaSpanId !== q.lemmaSpanId ||
        p.token?.id !== q.token?.id) {
      return false;
    }
  }
  return true;
};

export const useTokenPositions = (tokenData, lemmaSpans) => {
  const [tokenPositions, setTokenPositions] = useState([]);
  const sentenceGridRef = useRef(null);
  const tokenRefs = useRef(new Map());
  const resizeObserverRef = useRef(null);
  const positionsRef = useRef([]);

  // Function to measure actual token positions in the DOM
  const measureTokenPositions = useCallback(() => {
    if (!sentenceGridRef.current || !tokenData || tokenData.length === 0) return;

    const gridRect = sentenceGridRef.current.getBoundingClientRect();
    const positions = [];

    tokenData.forEach((data, index) => {
      const tokenRef = tokenRefs.current.get(data.token.id);
      if (tokenRef) {
        const tokenRect = tokenRef.getBoundingClientRect();
        const centerX = tokenRect.left + tokenRect.width / 2 - gridRect.left;
        const centerY = tokenRect.top + tokenRect.height / 2 - gridRect.top + 50; // Offset for SVG positioning
        
        // Find lemma span for this token
        const matchingLemmaSpan = lemmaSpans?.find(span => 
          (span.tokens && span.tokens.includes(data.token.id)) || span.begin === data.token.id
        );
        
        positions.push({
          token: data.token,
          x: centerX,
          y: centerY,
          width: tokenRect.width,
          form: data.tokenForm,
          lemmaSpanId: matchingLemmaSpan?.id,
          index: index
        });
      }
    });

    // Token geometry is unchanged on relation-only edits (deprel value, arc
    // add/remove): the rebuild hands us new token objects but the same layout.
    // Skip the state update in that case so the DependencyTree doesn't re-render
    // (and re-measure) a second time for nothing.
    if (samePositions(positionsRef.current, positions)) return;
    positionsRef.current = positions;
    setTokenPositions(positions);
  }, [tokenData, lemmaSpans]);

  // Update positions when layout changes
  useEffect(() => {
    // Use a timeout to ensure DOM is ready
    const timeoutId = setTimeout(() => {
      measureTokenPositions();
    }, 0);
    
    // Clean up previous observer
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
    }
    
    // Add resize observer to update positions when layout changes
    resizeObserverRef.current = new ResizeObserver(() => {
      measureTokenPositions();
    });
    
    if (sentenceGridRef.current) {
      resizeObserverRef.current.observe(sentenceGridRef.current);
    }
    
    return () => {
      clearTimeout(timeoutId);
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
    };
  }, [measureTokenPositions]);

  return {
    tokenPositions,
    sentenceGridRef,
    tokenRefs
  };
};