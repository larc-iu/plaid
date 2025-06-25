import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { DependencyTree } from './DependencyTree';
import { useTokenPositions } from './hooks/useTokenPositions';
import './editor.css';

export const SentenceRow = React.memo(({ 
  sentenceData, 
  onAnnotationUpdate, 
  onFeatureDelete,
  onRelationCreate,
  onRelationUpdate,
  onRelationDelete,
  sentenceIndex = 0, 
  totalTokensBefore = 0 
}) => {


  // Token data is already pre-processed in sentenceData
  const tokenData = sentenceData.tokens;

  // Calculate the maximum number of features across all tokens for row height
  const maxFeatures = Math.max(1, ...tokenData.map(data => data.feats.length));

  // Relations are already pre-processed in sentenceData
  const relations = sentenceData.relations;
  
  // Lemma spans are already pre-processed in sentenceData
  const lemmaSpans = sentenceData.lemmaSpans;

  // Create a text content object that can handle token extraction for DependencyTree
  const textContentProvider = {
    substring: (begin, end) => {
      // Find the token that matches these begin/end positions
      const matchingToken = tokenData.find(t => t.token.begin === begin && t.token.end === end);
      return matchingToken ? matchingToken.tokenForm : '';
    }
  };

  // Use the token positions hook
  const { tokenPositions, sentenceGridRef, tokenRefs } = useTokenPositions(
    tokenData, 
    lemmaSpans
  );

  // Editable cell component for annotation fields
  const EditableCell = React.memo(({ value, tokenId, field, tokenForm, tabIndex }) => {
    const [tempValue, setTempValue] = useState(value || '');
    const cellRef = useRef(null);

    useEffect(() => {
      setTempValue(value || '');
    }, [value]);

    const handleBlur = (e) => {
      const newValue = cellRef.current?.textContent || '';
      if (newValue !== (value || '')) {
        // Check if user is navigating to another editable field
        const isNavigatingToEditableField = e.relatedTarget && 
          (e.relatedTarget.contentEditable === 'true' || e.relatedTarget.contentEditable === true);
        
        // Skip optimistic updates if navigating between fields to preserve focus
        const skipOptimistic = isNavigatingToEditableField;
        
        // Delay the update to allow focus transfer to complete
        setTimeout(() => {
          onAnnotationUpdate(tokenId, field, newValue || null, skipOptimistic).catch(error => {
            console.error(`Failed to update ${field}:`, error);
            // Revert to original value on error
            if (cellRef.current) {
              cellRef.current.textContent = value || '';
            }
          });
        }, 0);
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        cellRef.current?.blur();
      } else if (e.key === 'Escape') {
        // Revert to original value
        if (cellRef.current) {
          cellRef.current.textContent = value || '';
        }
        cellRef.current?.blur();
      }
    };

    const handleFocus = () => {
      // Select all text when focused
      try {
        const range = window.document.createRange();
        const selection = window.getSelection();
        if (cellRef.current && range && selection) {
          range.selectNodeContents(cellRef.current);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch (error) {
        console.warn('Could not select text on focus:', error);
      }
    };

    const displayValue = value || (field === 'lemma' ? tokenForm : '');
    
    // Get current content from the DOM if available, otherwise use displayValue
    const getCurrentContent = () => {
      return cellRef.current?.textContent || displayValue;
    };

    // Determine styling based on current content, not just server value
    const currentContent = getCurrentContent();
    const hasContent = currentContent && currentContent.trim() !== '';
    
    return (
      <div
        ref={cellRef}
        contentEditable
        suppressContentEditableWarning
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onInput={() => {
          // Force re-render to update styling when user types
          const content = cellRef.current?.textContent || '';
          if (content !== tempValue) {
            setTempValue(content);
          }
        }}
        className={`editable-field ${hasContent ? 'editable-field--filled' : 'editable-field--empty'}`}
        title={`Edit ${field}`}
        tabIndex={tabIndex}
      >
        {displayValue}
      </div>
    );
  });

  // Features cell component with hover-only delete buttons
  const FeaturesCell = React.memo(({ features, spanIds, tokenId }) => {
    const [editingFeature, setEditingFeature] = useState(false);
    const [newFeature, setNewFeature] = useState('');
    const [isHovering, setIsHovering] = useState(false);
    const [hoveredFeatureIndex, setHoveredFeatureIndex] = useState(null);

    const handleAddFeature = async () => {
      if (!newFeature.trim()) return;
      
      // Validate format (key=value)
      if (!newFeature.includes('=')) {
        alert('Features must be in the format "key=value"');
        return;
      }

      try {
        await onAnnotationUpdate(tokenId, 'features', newFeature.trim());
        setNewFeature('');
        setEditingFeature(false);
      } catch (error) {
        console.error('Failed to add feature:', error);
      }
    };

    const handleRemoveFeature = async (featureIndex) => {
      const featureSpanInfo = spanIds?.features[featureIndex];
      if (!featureSpanInfo) {
        console.error('No span ID found for feature at index', featureIndex);
        return;
      }

      try {
        await onFeatureDelete(featureSpanInfo.spanId);
      } catch (error) {
        console.error('Failed to remove feature:', error);
      }
    };

    return (
      <div 
        className="features-container"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        {features.map((feature, index) => (
          <div
            key={index}
            className={`feature-tag ${hoveredFeatureIndex === index ? 'feature-tag--hovered' : 'feature-tag--normal'}`}
            onMouseEnter={() => setHoveredFeatureIndex(index)}
            onMouseLeave={() => setHoveredFeatureIndex(null)}
          >
            <span className="feature-text">{feature}</span>
            <button
              onClick={() => handleRemoveFeature(index)}
              className={`feature-delete-btn ${hoveredFeatureIndex === index ? 'feature-delete-btn--visible' : 'feature-delete-btn--hidden'}`}
              title="Remove feature"
            >
              ×
            </button>
          </div>
        ))}
        
        {editingFeature ? (
          <div className="feature-input-container">
            <input
              type="text"
              value={newFeature}
              onChange={(e) => setNewFeature(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddFeature();
                } else if (e.key === 'Escape') {
                  setNewFeature('');
                  setEditingFeature(false);
                }
              }}
              onBlur={() => {
                if (newFeature.trim()) {
                  handleAddFeature();
                } else {
                  setEditingFeature(false);
                }
              }}
              placeholder="key=value"
              className="feature-input"
              autoFocus
            />
          </div>
        ) : isHovering ? (
          <button
            onClick={() => setEditingFeature(true)}
            className="feature-add-btn"
          >
            +
          </button>
        ) : null}
      </div>
    );
  });

  // Calculate tab indices for row-wise navigation across all sentences
  const getTabIndex = useCallback((tokenIndex, field) => {
    const fieldOrder = { lemma: 0, xpos: 1, upos: 2 };
    const tokensInSentence = tokenData.length;
    
    // Calculate base index for this sentence (all previous sentences)
    const sentenceBaseIndex = totalTokensBefore * 3;
    
    // Row-wise: field type determines row, token index determines position in row
    const rowIndex = fieldOrder[field];
    const positionInRow = tokenIndex;
    
    return sentenceBaseIndex + (rowIndex * tokensInSentence) + positionInRow + 1;
  }, [tokenData.length, totalTokensBefore]);

  // Token Column component
  const TokenColumn = React.memo(({ data, index }) => {
    return (
      <div className="token-column">
        {/* Token form (baseline) */}
        <div 
          className="token-form"
          ref={(el) => {
            if (el) {
              tokenRefs.current.set(data.token.id, el);
            } else {
              tokenRefs.current.delete(data.token.id);
            }
          }}
        >
          {data.tokenForm}
        </div>

        {/* LEMMA */}
        <div className="annotation-cell">
          <EditableCell
            value={data.lemma?.value}
            tokenId={data.token.id}
            field="lemma"
            tokenForm={data.tokenForm}
            tabIndex={getTabIndex(index, 'lemma')}
          />
        </div>

        {/* XPOS */}
        <div className="annotation-cell">
          <EditableCell
            value={data.xpos?.value}
            tokenId={data.token.id}
            field="xpos"
            tokenForm={data.tokenForm}
            tabIndex={getTabIndex(index, 'xpos')}
          />
        </div>

        {/* UPOS */}
        <div className="annotation-cell">
          <EditableCell
            value={data.upos?.value}
            tokenId={data.token.id}
            field="upos"
            tokenForm={data.tokenForm}
            tabIndex={getTabIndex(index, 'upos')}
          />
        </div>

        {/* FEATS */}
        <div 
          className="features-cell"
          style={{ minHeight: `${Math.max(30, maxFeatures * 16 + 20)}px` }}
        >
          <FeaturesCell
            features={data.feats.map(feat => feat.value)}
            spanIds={{
              features: data.spanIds.features
            }}
            tokenId={data.token.id}
          />
        </div>
      </div>
    );
  });

  return (
    <div className="sentence-container">
      {/* Dependency tree visualization */}
      <DependencyTree
        tokens={sentenceData.tokens.map(t => t.token)}
        relations={relations}
        lemmaSpans={lemmaSpans}
        onRelationCreate={onRelationCreate}
        onRelationUpdate={onRelationUpdate}
        onRelationDelete={onRelationDelete}
        textContent={textContentProvider}
        tokenPositions={tokenPositions}
      />
      
      {/* Main container with labels and columns */}
      <div className="sentence-grid" ref={sentenceGridRef}>
        {/* Labels column */}
        <div className="labels-column">
          {/* Empty space for token form row */}
          <div className="label-spacer"></div>
          
          {/* LEMMA label */}
          <div className="row-label">
            LEMMA
          </div>
          
          {/* XPOS label */}
          <div className="row-label">
            XPOS
          </div>
          
          {/* UPOS label */}
          <div className="row-label">
            UPOS
          </div>
          
          {/* FEATS label */}
          <div 
            className="row-label"
            style={{
              minHeight: `${Math.max(30, maxFeatures * 16 + 20)}px`,
              alignItems: 'flex-start',
              paddingTop: '6px'
            }}
          >
            FEATS
          </div>
        </div>

        {/* Token columns */}
        {tokenData.map((data, index) => (
          <TokenColumn key={data.token.id} data={data} index={index} />
        ))}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return JSON.stringify(prevProps.sentenceData) === JSON.stringify(nextProps.sentenceData);
});