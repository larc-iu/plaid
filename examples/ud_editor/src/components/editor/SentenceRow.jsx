import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { DependencyTree } from './DependencyTree';
import { useTokenPositions } from './hooks/useTokenPositions';
import './editor.css';

// Editable cell component for annotation fields
const EditableCell = React.memo(({ value, tokenId, field, tokenForm, tabIndex, columnWidth, onUpdate, isReadOnly }) => {
  const [localValue, setLocalValue] = useState(value || '');
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isEditing) {
      setLocalValue(value || '');
    }
  }, [value, isEditing]);

  const handleChange = (e) => {
    setLocalValue(e.target.value);
  };

  const handleBlur = (e) => {
    setIsEditing(false);
    const newValue = localValue.trim();
    
    if (newValue !== (value || '')) {
      onUpdate(tokenId, field, newValue || null).catch(error => {
        console.error(`Failed to update ${field}:`, error);
        // Revert to original value on error
        setLocalValue(value || '');
      });
    } else {
      // Revert to original if unchanged
      setLocalValue(value || '');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      // Revert to original value
      setLocalValue(value || '');
      setIsEditing(false);
      inputRef.current?.blur();
    }
  };

  const handleFocus = () => {
    setIsEditing(true);
    // Select all text when focused
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  };

  const displayValue = localValue || (field === 'lemma' && !value && !isReadOnly ? tokenForm : '');
  const hasContent = displayValue && displayValue.trim() !== '';
  
  return (
    <input
      ref={inputRef}
      id={tabIndex}
      type="text"
      value={displayValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      className={`editable-field ${hasContent ? 'editable-field--filled' : 'editable-field--empty'}`}
      style={{ width: columnWidth ? `${columnWidth}px` : 'auto' }}
      title={`Edit ${field}`}
      tabIndex={tabIndex}
    />
  );
});

// Features cell component with hover-only delete buttons
const FeaturesCell = React.memo(({ features, spanIds, tokenId, columnWidth, onAnnotationUpdate, onFeatureDelete }) => {
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
      style={{ width: columnWidth ? `${columnWidth}px` : 'auto' }}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {features.map((feature, index) => (
        <div
          key={`${tokenId}-feat-${index}`}
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

// Token Column component
const TokenColumn = React.memo(({ data, index, columnWidth, getTabIndex, onAnnotationUpdate, onFeatureDelete, maxFeatures, tokenRefs, isReadOnly }) => {
  return (
    <div className="token-column" style={{ width: `${columnWidth}px` }}>
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
          columnWidth={columnWidth}
          onUpdate={onAnnotationUpdate}
          isReadOnly={isReadOnly}
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
          columnWidth={columnWidth}
          onUpdate={onAnnotationUpdate}
          isReadOnly={isReadOnly}
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
          columnWidth={columnWidth}
          onUpdate={onAnnotationUpdate}
          isReadOnly={isReadOnly}
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
          columnWidth={columnWidth}
          onAnnotationUpdate={onAnnotationUpdate}
          onFeatureDelete={onFeatureDelete}
        />
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.data === nextProps.data &&
    prevProps.index === nextProps.index &&
    prevProps.columnWidth === nextProps.columnWidth &&
    prevProps.maxFeatures === nextProps.maxFeatures &&
    prevProps.onAnnotationUpdate === nextProps.onAnnotationUpdate &&
    prevProps.onFeatureDelete === nextProps.onFeatureDelete &&
    prevProps.getTabIndex === nextProps.getTabIndex &&
    prevProps.isReadOnly === nextProps.isReadOnly
  );
});

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

  // Calculate column widths based on max content width
  const columnWidths = useMemo(() => {
    const widths = tokenData.map(data => {
      const charWidth = 8; // Approximate width per character
      const padding = 16; // Account for padding
      const minWidth = 40; // Minimum width
      
      // Calculate width for each field
      const tokenFormWidth = (data.tokenForm.length * charWidth) + padding;
      const lemmaWidth = ((data.lemma?.value || data.tokenForm).length * charWidth) + padding;
      const xposWidth = ((data.xpos?.value || '').length * charWidth) + padding;
      const uposWidth = ((data.upos?.value || '').length * charWidth) + padding;
      
      // Calculate width needed for features (find longest feature)
      const longestFeature = data.feats.reduce((longest, feat) => {
        return feat.value && feat.value.length > longest.length ? feat.value : longest;
      }, '');
      const featuresWidth = longestFeature ? (longestFeature.length * charWidth) + padding : minWidth;
      
      // Return max width for this column
      return Math.max(minWidth, tokenFormWidth, lemmaWidth, xposWidth, uposWidth, featuresWidth);
    });
    
    return widths;
  }, [tokenData]);

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


  // Detect if we're in read-only mode (historical state)
  const isReadOnly = onAnnotationUpdate === null;

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
          <TokenColumn 
            key={data.token.id} 
            data={data} 
            index={index} 
            columnWidth={columnWidths[index]}
            getTabIndex={getTabIndex}
            onAnnotationUpdate={onAnnotationUpdate}
            onFeatureDelete={onFeatureDelete}
            maxFeatures={maxFeatures}
            tokenRefs={tokenRefs}
            isReadOnly={isReadOnly}
          />
        ))}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return JSON.stringify(prevProps.sentenceData) === JSON.stringify(nextProps.sentenceData);
});