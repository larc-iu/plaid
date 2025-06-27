import React, { useState, useEffect, useRef } from 'react';
import { SentenceRow } from './SentenceRow';

const VirtualSentenceRow = ({ 
  sentenceData, 
  onAnnotationUpdate, 
  onFeatureDelete,
  onRelationCreate,
  onRelationUpdate,
  onRelationDelete,
  sentenceIndex = 0, 
  totalTokensBefore = 0,
  estimatedHeight = 200 // Default estimated height in pixels
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const containerRef = useRef(null);
  const observerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create intersection observer with root margin for pre-loading
    observerRef.current = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        setIsVisible(entry.isIntersecting);
        
        // Once visible, keep track for smooth transitions
        if (entry.isIntersecting) {
          setHasBeenVisible(true);
        }
      },
      {
        // Pre-load sentences 300px before they enter viewport
        rootMargin: '300px 0px 300px 0px',
        threshold: 0
      }
    );

    observerRef.current.observe(containerRef.current);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  // Render placeholder when not visible and hasn't been rendered yet
  if (!isVisible && !hasBeenVisible) {
    return (
      <div 
        ref={containerRef}
        style={{ 
          height: `${estimatedHeight}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9ca3af',
          fontSize: '14px',
          border: '1px dashed #e5e7eb',
          margin: '4px 0'
        }}
      >
        Loading sentence {sentenceIndex + 1}...
      </div>
    );
  }

  // Render full component when visible or has been visible
  return (
    <div ref={containerRef}>
      <SentenceRow
        sentenceData={sentenceData}
        onAnnotationUpdate={onAnnotationUpdate}
        onFeatureDelete={onFeatureDelete}
        onRelationCreate={onRelationCreate}
        onRelationUpdate={onRelationUpdate}
        onRelationDelete={onRelationDelete}
        sentenceIndex={sentenceIndex}
        totalTokensBefore={totalTokensBefore}
      />
    </div>
  );
};

export { VirtualSentenceRow };