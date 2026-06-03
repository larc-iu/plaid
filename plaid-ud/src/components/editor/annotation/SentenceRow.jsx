import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Autocomplete } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { DependencyTree } from './DependencyTree.jsx';
import { useTokenPositions } from '../hooks/useTokenPositions.js';
import { notifyError } from '../../../utils/feedback.jsx';
import { resolveColor } from '../../../utils/udVocab.js';
import './SentenceRow.css';

// Shared throttle for tab navigation across all EditableCell instances
let lastGlobalTabPress = 0;

// Fallback when no per-document visibility is supplied (e.g. historical view):
// show every annotation row. Stable reference so memoized children don't churn.
const ALL_FIELDS_VISIBLE = { lemma: true, xpos: true, upos: true, feats: true };

// Stable empty-options reference: idle vocab cells pass this (instead of the
// real suggestion list) so Mantine doesn't keep ~17 hidden option nodes mounted
// per cell. Options populate only while the cell is focused/editing.
const NO_OPTIONS = [];

// Editable cell component for annotation fields
const EditableCell = React.memo(({ value, tokenId, tokenIndex, field, tokenForm, tabIndex, columnWidth, onUpdate, onNavigate, isReadOnly, suggestions, cellColor }) => {
  const [localValue, setLocalValue] = useState(value || '');
  const [isEditing, setIsEditing] = useState(false);
  // `pristine` = focused but not yet typed: the vocab dropdown shows the full
  // list; the first keystroke flips it off so the list filters.
  const [pristine, setPristine] = useState(true);
  const inputRef = useRef(null);
  // Mirror `isEditing` into a ref so the value-sync effect can read the latest
  // value without listing `isEditing` in its deps (see below).
  const isEditingRef = useRef(false);
  isEditingRef.current = isEditing;

  // Sync localValue ONLY when the external `value` prop actually changes (e.g.
  // the server-confirmed optimistic patch, a reload, or another annotator).
  // Deliberately NOT keyed on `isEditing`: firing on the blur transition would
  // momentarily reset the input to the stale prop value during the save round
  // trip, flashing the previous value before the new one lands. handleBlur
  // already commits-or-reverts explicitly, so no blur-time reset is needed.
  useEffect(() => {
    if (!isEditingRef.current) {
      setLocalValue(value || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

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
    // Throttle tab key presses to prevent browser hanging
    if (e.key === 'Tab') {
      const now = Date.now();
      if (now - lastGlobalTabPress < 55) {
        e.preventDefault();
        return;
      }
      lastGlobalTabPress = now;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'Escape') {
      // Revert to original value
      setLocalValue(value || '');
      setIsEditing(false);
      inputRef.current?.blur();
      return;
    }

    // Grid navigation. Up/Down always navigate (single-line inputs don't use
    // them anyway). Left/Right navigate only at the edge of the input so
    // they still move the caret within text.
    if (e.key === 'ArrowUp') {
      if (onNavigate?.(field, tokenIndex, 'up')) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (onNavigate?.(field, tokenIndex, 'down')) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft') {
      const input = inputRef.current;
      const atStart = input && input.selectionStart === 0 && input.selectionEnd === 0;
      if (atStart && onNavigate?.(field, tokenIndex, 'left')) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight') {
      const input = inputRef.current;
      const len = input?.value?.length ?? 0;
      const atEnd = input && input.selectionStart === len && input.selectionEnd === len;
      if (atEnd && onNavigate?.(field, tokenIndex, 'right')) e.preventDefault();
      return;
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
  const fieldClass = `editable-field ${hasContent ? 'editable-field--filled' : 'editable-field--empty'}`;

  // Vocab cells (UPOS/XPOS) use a Mantine Autocomplete: clicking opens the FULL
  // controlled list and it filters only once the user starts typing (the custom
  // `pristine` filter). Off-list values are still accepted (soft). It reuses the
  // `.editable-field` styling so it matches the grid, and has no native picker
  // arrow (which is what shifted the datalist's centered text off-center).
  if (suggestions && suggestions.length && !isReadOnly) {
    const optionsFilter = ({ options, search }) => {
      if (pristine) return options;
      const q = search.toLowerCase().trim();
      return options.filter((o) => o.label.toLowerCase().includes(q));
    };
    return (
      <Autocomplete
        ref={inputRef}
        id={`${tokenId}-${field}`}
        data={isEditing ? suggestions : NO_OPTIONS}
        value={displayValue}
        onChange={(val) => { setLocalValue(val); setPristine(false); }}
        onFocus={() => { setIsEditing(true); setPristine(true); setTimeout(() => inputRef.current?.select(), 0); }}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            const now = Date.now();
            if (now - lastGlobalTabPress < 55) { e.preventDefault(); return; }
            lastGlobalTabPress = now;
          } else if (e.key === 'Escape') {
            setLocalValue(value || '');
            inputRef.current?.blur();
          }
        }}
        filter={optionsFilter}
        selectFirstOptionOnChange={false}
        variant="unstyled"
        size="xs"
        tabIndex={tabIndex}
        title={`Edit ${field}`}
        classNames={{ input: fieldClass }}
        styles={{
          // Match the plain inputs: take the full column width and be allowed to
          // overflow the (narrower) cell. Mantine's default max-width:100% would
          // otherwise trap the field at the cell width, clipping longer tags and
          // shifting the text left of center.
          root: { width: columnWidth ? `${columnWidth}px` : 'auto', maxWidth: 'none', flexShrink: 0 },
          input: { width: '100%', height: 'auto', minHeight: 18, lineHeight: '16px', textAlign: 'center', color: hasContent && cellColor ? cellColor : undefined },
          // The cell column can be very narrow; let the dropdown grow to fit its
          // options and keep each tag on a single line (no char-by-char wrap).
          dropdown: { minWidth: 'max-content' },
          option: { whiteSpace: 'nowrap' }
        }}
        maxDropdownHeight={240}
        comboboxProps={{ withinPortal: true }}
      />
    );
  }

  return (
    <input
      ref={inputRef}
      id={`${tokenId}-${field}`}
      type="text"
      value={displayValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      className={fieldClass}
      style={{
        width: columnWidth ? `${columnWidth}px` : 'auto',
        ...(hasContent && cellColor ? { color: cellColor } : {})
      }}
      title={`Edit ${field}`}
      tabIndex={tabIndex}
    />
  );
});

// Features cell component with hover-only delete buttons
const FeaturesCell = React.memo(({ features, spanIds, tokenId, columnWidth, onAnnotationUpdate, onFeatureDelete, featureInventory }) => {
  const [editingFeature, setEditingFeature] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [isHovering, setIsHovering] = useState(false);
  const [hoveredFeatureIndex, setHoveredFeatureIndex] = useState(null);

  // Controlled key/value pickers drawn from the configurable UD feature
  // inventory; both are soft (native datalists), so new keys/values are allowed.
  const inv = featureInventory || { list: [], map: new Map() };
  const featureKeys = inv.list.map((e) => e.key);
  const valueOptions = inv.map.get(newKey) || [];

  const resetEditor = () => {
    setNewKey('');
    setNewValue('');
    setEditingFeature(false);
  };

  const handleAddFeature = async () => {
    const key = newKey.trim();
    const val = newValue.trim();
    if (!key || !val) {
      notifyError('A feature needs both a name and a value.');
      return;
    }

    try {
      await onAnnotationUpdate(tokenId, 'features', `${key}=${val}`);
      resetEditor();
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
        <div
          className="feature-input-container"
          onBlur={(e) => {
            // Commit/cancel only when focus leaves the editor entirely —
            // tabbing between the key and value inputs keeps it open.
            if (e.currentTarget.contains(e.relatedTarget)) return;
            if (newKey.trim() && newValue.trim()) handleAddFeature();
            else resetEditor();
          }}
        >
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddFeature();
              } else if (e.key === 'Escape') {
                resetEditor();
              }
            }}
            placeholder="Feature"
            className="feature-input"
            list={`feat-keys-${tokenId}`}
            autoFocus
          />
          <datalist id={`feat-keys-${tokenId}`}>
            {featureKeys.map((k) => <option key={k} value={k} />)}
          </datalist>
          <span className="feature-eq">=</span>
          <input
            type="text"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddFeature();
              } else if (e.key === 'Escape') {
                resetEditor();
              }
            }}
            placeholder="Value"
            className="feature-input"
            list={`feat-vals-${tokenId}`}
          />
          <datalist id={`feat-vals-${tokenId}`}>
            {valueOptions.map((v) => <option key={v} value={v} />)}
          </datalist>
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
const TokenColumn = React.memo(({ data, index, columnWidth, getTabIndex, onAnnotationUpdate, onFeatureDelete, onNavigate, maxFeatures, tokenRefs, isReadOnly, vocab, uposColors, featureInventory, visibleFields }) => {
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
      {visibleFields.lemma ? (
        <div className="annotation-cell">
          <EditableCell
            value={data.lemma?.value}
            tokenId={data.token.id}
            tokenIndex={index}
            field="lemma"
            tokenForm={data.tokenForm}
            tabIndex={getTabIndex(index, 'lemma')}
            columnWidth={columnWidth}
            onUpdate={onAnnotationUpdate}
            onNavigate={onNavigate}
            isReadOnly={isReadOnly}
          />
        </div>
      ) : (
        <div className="annotation-cell" />
      )}

      {/* XPOS */}
      {visibleFields.xpos ? (
        <div className="annotation-cell">
          <EditableCell
            value={data.xpos?.value}
            tokenId={data.token.id}
            tokenIndex={index}
            field="xpos"
            tokenForm={data.tokenForm}
            tabIndex={getTabIndex(index, 'xpos')}
            columnWidth={columnWidth}
            onUpdate={onAnnotationUpdate}
            onNavigate={onNavigate}
            isReadOnly={isReadOnly}
            suggestions={vocab?.xpos}
          />
        </div>
      ) : (
        <div className="annotation-cell" />
      )}

      {/* UPOS */}
      {visibleFields.upos ? (
        <div className="annotation-cell">
          <EditableCell
            value={data.upos?.value}
            tokenId={data.token.id}
            tokenIndex={index}
            field="upos"
            tokenForm={data.tokenForm}
            tabIndex={getTabIndex(index, 'upos')}
            columnWidth={columnWidth}
            onUpdate={onAnnotationUpdate}
            onNavigate={onNavigate}
            isReadOnly={isReadOnly}
            suggestions={vocab?.upos}
            cellColor={data.upos?.value ? resolveColor(data.upos.value, uposColors) : undefined}
          />
        </div>
      ) : (
        <div className="annotation-cell" />
      )}

      {/* FEATS */}
      {visibleFields.feats ? (
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
            featureInventory={featureInventory}
          />
        </div>
      ) : (
        <div className="annotation-cell" />
      )}
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
    prevProps.onNavigate === nextProps.onNavigate &&
    prevProps.getTabIndex === nextProps.getTabIndex &&
    prevProps.isReadOnly === nextProps.isReadOnly &&
    // Stable identity per layerInfo version, so these don't trigger re-renders.
    prevProps.vocab === nextProps.vocab &&
    prevProps.uposColors === nextProps.uposColors &&
    prevProps.featureInventory === nextProps.featureInventory &&
    prevProps.visibleFields === nextProps.visibleFields
  );
});

// Clickable row header (LEMMA/XPOS/UPOS/FEATS). Always shown so a collapsed row
// can be re-expanded; the leading chevron reflects state (rotated down = expanded,
// pointing right = collapsed), matching the relation-color legend disclosure.
// When no onToggle is provided (e.g. the read-only historical view) it renders as
// a plain, non-interactive label.
const RowLabelHeader = ({ field, label, expanded, onToggle, style }) => {
  const interactive = Boolean(onToggle);
  return (
    <div
      className={`row-label${interactive ? ' row-label--toggle' : ''}`}
      style={style}
      onClick={interactive ? () => onToggle(field) : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? -1 : undefined}
      title={interactive ? `${expanded ? 'Hide' : 'Show'} ${label}` : undefined}
    >
      {interactive && (
        <IconChevronRight
          size={12}
          className="row-label__chevron"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms ease'
          }}
        />
      )}
      {label}
    </div>
  );
};

export const SentenceRow = React.memo(({
  sentenceData, 
  onAnnotationUpdate, 
  onFeatureDelete,
  onRelationCreate,
  onRelationUpdate,
  onRelationDelete,
  sentenceIndex = 0,
  totalTokensBefore = 0,
  vocab,
  colors,
  visibleFields = ALL_FIELDS_VISIBLE,
  onToggleField
}) => {

  // Token data is already pre-processed in sentenceData
  const tokenData = sentenceData.tokens;

  // Calculate column widths based on max content width
  const columnWidths = useMemo(() => {
    const widths = tokenData.map(data => {
      const charWidth = 8; // Approximate width per character
      const padding = 16; // Account for padding
      const minWidth = 40; // Minimum width
      
      // Token form row is always shown, so it always contributes width.
      const candidates = [minWidth, (data.tokenForm.length * charWidth) + padding];

      // Only let a field widen the column when it's actually visible — hiding
      // FEATS in particular collapses the over-wide columns it would force.
      if (visibleFields.lemma)
        candidates.push(((data.lemma?.value || data.tokenForm).length * charWidth) + padding);
      if (visibleFields.xpos)
        candidates.push(((data.xpos?.value || '').length * charWidth) + padding);
      if (visibleFields.upos)
        candidates.push(((data.upos?.value || '').length * charWidth) + padding);
      if (visibleFields.feats) {
        const longestFeature = data.feats.reduce((longest, feat) => {
          return feat.value && feat.value.length > longest.length ? feat.value : longest;
        }, '');
        candidates.push(longestFeature ? (longestFeature.length * charWidth) + padding : minWidth);
      }

      // Return max width for this column
      return Math.max(...candidates);
    });

    return widths;
  }, [tokenData, visibleFields]);

  // Calculate the maximum number of features across all tokens for row height
  const maxFeatures = Math.max(1, ...tokenData.map(data => data.feats.length));
  // Height of the FEATS row when expanded (grows with the busiest token's tags).
  const featsExpandedHeight = Math.max(30, maxFeatures * 16 + 20);

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

  // Arrow-key navigation within the sentence's annotation grid.
  // Up/Down step through LEMMA → XPOS → UPOS for a fixed token column;
  // Left/Right step through tokens at a fixed field. FEATS is omitted
  // because its cell type is different (no editable text input to focus).
  // Returns true on a successful focus shift so the caller can preventDefault.
  // Hidden rows are excluded so Up/Down skips over them rather than dead-ending.
  const NAV_FIELDS = useMemo(
    () => ['lemma', 'xpos', 'upos'].filter((f) => visibleFields[f]),
    [visibleFields]
  );
  const onNavigate = useCallback((field, tokenIndex, dir) => {
    let nextField = field;
    let nextTokenIdx = tokenIndex;
    if (dir === 'up' || dir === 'down') {
      const fi = NAV_FIELDS.indexOf(field);
      const ni = fi + (dir === 'up' ? -1 : 1);
      if (fi < 0 || ni < 0 || ni >= NAV_FIELDS.length) return false;
      nextField = NAV_FIELDS[ni];
    } else if (dir === 'left' || dir === 'right') {
      const ni = tokenIndex + (dir === 'left' ? -1 : 1);
      if (ni < 0 || ni >= tokenData.length) return false;
      nextTokenIdx = ni;
    } else {
      return false;
    }
    const target = tokenData[nextTokenIdx];
    if (!target) return false;
    const el = document.getElementById(`${target.token.id}-${nextField}`);
    if (!el) return false;
    el.focus();
    return true;
  }, [tokenData, NAV_FIELDS]);

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
        deprelColors={colors?.deprel}
        deprelVocab={vocab?.deprel}
      />

      {/* Main container with labels and columns */}
      <div className="sentence-grid" ref={sentenceGridRef}>
        {/* Labels column */}
        <div className="labels-column">
          {/* Empty space for token form row */}
          <div className="label-spacer"></div>

          {/* Row headers — always visible, click to expand/collapse */}
          <RowLabelHeader field="lemma" label="LEMMA" expanded={visibleFields.lemma} onToggle={onToggleField} />
          <RowLabelHeader field="xpos" label="XPOS" expanded={visibleFields.xpos} onToggle={onToggleField} />
          <RowLabelHeader field="upos" label="UPOS" expanded={visibleFields.upos} onToggle={onToggleField} />
          <RowLabelHeader
            field="feats"
            label="FEATS"
            expanded={visibleFields.feats}
            onToggle={onToggleField}
            style={visibleFields.feats
              ? { minHeight: `${featsExpandedHeight}px`, alignItems: 'flex-start', paddingTop: '6px' }
              : undefined}
          />
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
            onNavigate={onNavigate}
            maxFeatures={maxFeatures}
            tokenRefs={tokenRefs}
            isReadOnly={isReadOnly}
            vocab={vocab}
            uposColors={colors?.upos}
            featureInventory={vocab?.featureInventory}
            visibleFields={visibleFields}
          />
        ))}
      </div>
    </div>
  );
});