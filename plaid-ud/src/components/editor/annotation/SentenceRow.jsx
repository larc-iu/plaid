import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Autocomplete, Button } from '@mantine/core';
import { IconChevronRight, IconCheck } from '@tabler/icons-react';
import { provState, PROV_STATES } from '@larc-iu/plaid-client';
import { DependencyTree } from './DependencyTree.jsx';
import { useTokenPositions } from '../hooks/useTokenPositions.js';
import { resolveColor } from '../../../utils/udVocab.js';
import { readFieldProbs, groupSuggestions, probLabel, provCellTitle } from '../../../utils/provenanceUi.js';
import './SentenceRow.css';

// Machine-made, not yet human-verified (provenance convention) — such cells
// render distinctly (italic + dotted violet underline) until a human edits
// them, which verifies them.
const isInferredSpan = (span) => !!span && provState(span.metadata) === PROV_STATES.MACHINE;

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
const EditableCell = React.memo(({ value, tokenId, tokenIndex, field, tokenForm, tabIndex, columnWidth, onUpdate, onNavigate, isReadOnly, suggestions, cellColor, isInferred, provMeta }) => {
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
  const fieldClass = `editable-field ${hasContent ? 'editable-field--filled' : 'editable-field--empty'}`
    + (isInferred && hasContent ? ' editable-field--inferred' : '');

  // Machine-origin record for the tooltip + the producer's distribution (when
  // one was recorded in provDetail) for ranking the dropdown.
  const cellTitle = provCellTitle(`Edit ${field}`, provMeta);
  const fieldProbs = readFieldProbs(provMeta, field);

  // Read-only (viewer access or time travel): render the value as static text,
  // not an editable input, so cells can't be focused or typed into at all.
  if (isReadOnly) {
    return (
      <div
        className={fieldClass}
        style={{
          width: columnWidth ? `${columnWidth}px` : 'auto',
          cursor: 'default',
          ...(hasContent && cellColor ? { color: cellColor } : {})
        }}
        title={provCellTitle(field, provMeta)}
      >
        {hasContent ? displayValue : ' '}
      </div>
    );
  }

  // Vocab cells (UPOS/XPOS) use a Mantine Autocomplete: clicking opens the FULL
  // controlled list and it filters only once the user starts typing (the custom
  // `pristine` filter). Off-list values are still accepted (soft). It reuses the
  // `.editable-field` styling so it matches the grid, and has no native picker
  // arrow (which is what shifted the datalist's centered text off-center).
  // When the producing parser recorded a distribution, its top-k floats above
  // the rest as a "Parser suggestions" group, with the probability rendered as
  // a dimmed suffix (renderOption only — the committed value stays the bare tag).
  if (suggestions && suggestions.length && !isReadOnly) {
    // Group-aware pristine filter: the data may be flat or grouped.
    const filterItems = (items, q) => items.filter((o) => o.label.toLowerCase().includes(q));
    const optionsFilter = ({ options, search }) => {
      if (pristine) return options;
      const q = search.toLowerCase().trim();
      return options
        .map((o) => ('group' in o ? { ...o, items: filterItems(o.items, q) } : o))
        .filter((o) => ('group' in o ? o.items.length > 0 : o.label.toLowerCase().includes(q)));
    };
    return (
      <Autocomplete
        ref={inputRef}
        id={`${tokenId}-${field}`}
        data={isEditing ? groupSuggestions(suggestions, fieldProbs) : NO_OPTIONS}
        renderOption={fieldProbs ? ({ option }) => {
          const pct = probLabel(fieldProbs, option.value);
          return (
            <span>
              {option.value}
              {pct && <span style={{ opacity: 0.55, marginLeft: 6, fontSize: '0.85em' }}>{pct}</span>}
            </span>
          );
        } : undefined}
        value={displayValue}
        onChange={(val) => { setLocalValue(val); setPristine(false); }}
        onFocus={() => { setIsEditing(true); setPristine(true); setTimeout(() => inputRef.current?.select(), 0); }}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            const now = Date.now();
            if (now - lastGlobalTabPress < 55) { e.preventDefault(); return; }
            lastGlobalTabPress = now;
            return;
          }
          if (e.key === 'Escape') {
            setLocalValue(value || '');
            inputRef.current?.blur();
            return;
          }
          // Grid navigation, like the plain-input cells — but only while the
          // dropdown is closed (open, the arrows highlight options). Escape
          // closes the dropdown first, then arrows navigate.
          const dropdownOpen = e.target.getAttribute('aria-expanded') === 'true';
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            if (!dropdownOpen && onNavigate?.(field, tokenIndex, e.key === 'ArrowUp' ? 'up' : 'down')) {
              e.preventDefault();
            }
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
          }
        }}
        filter={optionsFilter}
        selectFirstOptionOnChange={false}
        variant="unstyled"
        size="xs"
        tabIndex={tabIndex}
        title={cellTitle}
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
      title={cellTitle}
      tabIndex={tabIndex}
    />
  );
});

// Features cell component with hover-only delete buttons
// FEATS is a token-field (chip input): the cell IS one slim input, with the
// feature pills stacked above it. Arriving (Tab / arrows / click) focuses the
// input directly, so adding is just typing — suggestions offer inventory keys
// ("Case=") until '=' is typed, then that key's values; everything stays soft
// (off-list features allowed), and committing an existing key overwrites it
// (domain semantics in updateAnnotation). Keyboard deletion is the classic
// chip-input gesture: Backspace at an empty input selects the last pill,
// Left/Right move the selection, Backspace/Delete remove it, typing or Escape
// clears it. Left/Right at an empty input with no selection fall through to
// grid column navigation, like every other cell.
const FeaturesCell = React.memo(({ features, featureInferred, spanIds, tokenId, tokenIndex, tabIndex, columnWidth, onAnnotationUpdate, onFeatureDelete, onNavigate, featureInventory, isReadOnly }) => {
  const [text, setText] = useState('');
  const [selectedPill, setSelectedPill] = useState(null); // index into features, or null
  const [isEditing, setIsEditing] = useState(false);
  const [hoveredFeatureIndex, setHoveredFeatureIndex] = useState(null);
  const inputRef = useRef(null);
  // Mantine fires onOptionSubmit BEFORE its own onChange(option), so after an
  // option-pick commit the echoed onChange would resurrect the committed text
  // in the input. Set on commit-by-pick; onChange consumes it and swallows
  // that one echo.
  const optionCommittedRef = useRef(false);

  const inv = featureInventory || { list: [], map: new Map() };

  // Two-stage suggestions: keys (as "Key=") until '=' is typed, then values.
  const eqIdx = text.indexOf('=');
  const suggestions = eqIdx === -1
    ? inv.list.map((e) => `${e.key}=`)
    : (inv.map.get(text.slice(0, eqIdx).trim()) || []).map((v) => `${text.slice(0, eqIdx)}=${v}`);

  const commit = (raw) => {
    const t = (raw ?? text).trim();
    const i = t.indexOf('=');
    if (i <= 0 || i === t.length - 1) return false; // need non-empty Key=Value
    setText('');
    onAnnotationUpdate(tokenId, 'features', t).catch((error) => {
      console.error('Failed to add feature:', error);
    });
    return true;
  };

  const removePill = (index) => {
    const featureSpanInfo = spanIds?.features[index];
    setSelectedPill(null);
    if (!featureSpanInfo) {
      console.error('No span ID found for feature at index', index);
      return;
    }
    onFeatureDelete(featureSpanInfo.spanId).catch((error) => {
      console.error('Failed to remove feature:', error);
    });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Tab') {
      const now = Date.now();
      if (now - lastGlobalTabPress < 55) { e.preventDefault(); return; }
      lastGlobalTabPress = now;
      return;
    }
    const input = inputRef.current;
    const empty = !text;
    // While the dropdown is open (or an option is highlighted), Enter and the
    // vertical arrows belong to the combobox, not to us.
    const dropdownOpen = e.target.getAttribute('aria-expanded') === 'true';
    const optionActive = Boolean(e.target.getAttribute('aria-activedescendant'));

    if (e.key === 'Enter') {
      if (!optionActive) {
        e.preventDefault();
        commit();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (selectedPill != null) { e.preventDefault(); setSelectedPill(null); return; }
      if (!dropdownOpen) { setText(''); input?.blur(); }
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (selectedPill != null) { e.preventDefault(); removePill(selectedPill); return; }
      if (e.key === 'Backspace' && empty && features.length > 0) {
        e.preventDefault();
        setSelectedPill(features.length - 1);
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      if (selectedPill != null) { e.preventDefault(); setSelectedPill(Math.max(0, selectedPill - 1)); return; }
      const atStart = input && input.selectionStart === 0 && input.selectionEnd === 0;
      if (atStart && empty && onNavigate?.('feats', tokenIndex, 'left')) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight') {
      if (selectedPill != null) {
        e.preventDefault();
        setSelectedPill(selectedPill >= features.length - 1 ? null : selectedPill + 1);
        return;
      }
      const len = input?.value?.length ?? 0;
      const atEnd = input && input.selectionStart === len && input.selectionEnd === len;
      if (atEnd && empty && onNavigate?.('feats', tokenIndex, 'right')) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!dropdownOpen && onNavigate?.('feats', tokenIndex, 'up')) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (!dropdownOpen && onNavigate?.('feats', tokenIndex, 'down')) e.preventDefault();
      return;
    }
  };

  return (
    <div
      className="features-container"
      style={{ width: columnWidth ? `${columnWidth}px` : 'auto' }}
    >
      {features.map((feature, index) => (
        <div
          key={`${tokenId}-feat-${index}`}
          className={`feature-tag ${selectedPill === index
            ? 'feature-tag--selected'
            : hoveredFeatureIndex === index ? 'feature-tag--hovered' : 'feature-tag--normal'}`}
          onMouseEnter={() => setHoveredFeatureIndex(index)}
          onMouseLeave={() => setHoveredFeatureIndex(null)}
          onClick={isReadOnly ? undefined : () => { setSelectedPill(index); inputRef.current?.focus(); }}
        >
          <span className={`feature-text${featureInferred?.[index] ? ' feature-text--inferred' : ''}`}>{feature}</span>
          {!isReadOnly && (
            <button
              onClick={(e) => { e.stopPropagation(); removePill(index); }}
              className={`feature-delete-btn ${(hoveredFeatureIndex === index || selectedPill === index) ? 'feature-delete-btn--visible' : 'feature-delete-btn--hidden'}`}
              title="Remove feature"
              tabIndex={-1}
            >
              ×
            </button>
          )}
        </div>
      ))}

      {!isReadOnly && (
        <Autocomplete
          ref={inputRef}
          id={`${tokenId}-feats`}
          data={isEditing ? suggestions : NO_OPTIONS}
          value={text}
          onChange={(val) => {
            if (optionCommittedRef.current) { optionCommittedRef.current = false; return; }
            setText(val);
            setSelectedPill(null);
          }}
          onFocus={() => setIsEditing(true)}
          onBlur={() => {
            // Commit a complete Key=Value on the way out; discard fragments.
            setIsEditing(false);
            setSelectedPill(null);
            if (!commit()) setText('');
          }}
          onOptionSubmit={(option) => {
            // A bare "Key=" pick just fills the input (keep typing the value);
            // a full "Key=Value" pick commits immediately.
            if (!option.endsWith('=')) {
              optionCommittedRef.current = true;
              commit(option);
            }
          }}
          onKeyDown={handleKeyDown}
          selectFirstOptionOnChange={false}
          variant="unstyled"
          size="xs"
          tabIndex={tabIndex}
          placeholder="+"
          title="Add feature (Key=Value)"
          classNames={{ input: 'feature-chip-input' }}
          styles={{
            root: { width: '100%', maxWidth: 'none' },
            input: { width: '100%', height: 'auto', minHeight: 18, lineHeight: '14px', textAlign: 'center' },
            dropdown: { minWidth: 'max-content' },
            option: { whiteSpace: 'nowrap' }
          }}
          maxDropdownHeight={240}
          comboboxProps={{ withinPortal: true }}
        />
      )}
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
            isInferred={isInferredSpan(data.lemma)}
            provMeta={data.lemma?.metadata}
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
            isInferred={isInferredSpan(data.xpos)}
            provMeta={data.xpos?.metadata}
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
            isInferred={isInferredSpan(data.upos)}
            provMeta={data.upos?.metadata}
          />
        </div>
      ) : (
        <div className="annotation-cell" />
      )}

      {/* FEATS */}
      {visibleFields.feats ? (
        <div
          className="features-cell"
          // Tall enough for the longest pill stack in the row, plus the
          // always-present chip input when editable.
          style={{ minHeight: `${Math.max(30, maxFeatures * 16 + (isReadOnly ? 8 : 26))}px` }}
        >
          <FeaturesCell
            features={data.feats.map(feat => feat.value)}
            featureInferred={data.feats.map(isInferredSpan)}
            spanIds={{
              features: data.spanIds.features
            }}
            tokenId={data.token.id}
            tokenIndex={index}
            tabIndex={getTabIndex(index, 'feats')}
            columnWidth={columnWidth}
            onAnnotationUpdate={onAnnotationUpdate}
            onFeatureDelete={onFeatureDelete}
            onNavigate={onNavigate}
            featureInventory={featureInventory}
            isReadOnly={isReadOnly}
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
  onConfirmTokens,
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

  // Imperative handle into this sentence's dependency tree, for the arrow
  // handoff between the grid and the deprel labels.
  const treeRef = useRef(null);


  // Detect if we're in read-only mode (historical state)
  const isReadOnly = onAnnotationUpdate === null;

  // Calculate tab indices for row-wise navigation across all sentences
  const getTabIndex = useCallback((tokenIndex, field) => {
    const fieldOrder = { lemma: 0, xpos: 1, upos: 2, feats: 3 };
    const tokensInSentence = tokenData.length;

    // Calculate base index for this sentence (all previous sentences)
    const sentenceBaseIndex = totalTokensBefore * 4;

    // Row-wise: field type determines row, token index determines position in row
    const rowIndex = fieldOrder[field];
    const positionInRow = tokenIndex;

    return sentenceBaseIndex + (rowIndex * tokensInSentence) + positionInRow + 1;
  }, [tokenData.length, totalTokensBefore]);

  // Arrow-key navigation within the sentence's annotation grid.
  // Up/Down step through LEMMA → XPOS → UPOS → FEATS for a fixed token
  // column; Left/Right step through tokens at a fixed field. Every cell's
  // focusable input carries the id `${tokenId}-${field}` (FEATS included —
  // its chip input is `${tokenId}-feats`).
  // Returns true on a successful focus shift so the caller can preventDefault.
  // Hidden rows are excluded so Up/Down skips over them rather than dead-ending.
  const NAV_FIELDS = useMemo(
    () => ['lemma', 'xpos', 'upos', 'feats'].filter((f) => visibleFields[f]),
    [visibleFields]
  );
  const onNavigate = useCallback((field, tokenIndex, dir) => {
    let nextField = field;
    let nextTokenIdx = tokenIndex;
    if (dir === 'up' || dir === 'down') {
      const fi = NAV_FIELDS.indexOf(field);
      if (fi < 0) return false;
      const ni = fi + (dir === 'up' ? -1 : 1);
      if (ni < 0) {
        // Top annotation row + ArrowUp: hand off to this token's deprel label
        // in the tree above. Falls through (dead-ends) if it has no relation.
        return treeRef.current?.focusRelationForToken(tokenData[tokenIndex]?.token.id) || false;
      }
      if (ni >= NAV_FIELDS.length) return false;
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

  // ArrowDown out of a deprel label lands on that dependent token's top
  // (first visible) annotation cell — the mirror of the ArrowUp handoff above.
  const focusGridCell = useCallback((tokenId) => {
    const top = NAV_FIELDS[0];
    if (!top) return;
    document.getElementById(`${tokenId}-${top}`)?.focus();
  }, [NAV_FIELDS]);

  // Provenance review (see ConlluDocument.confirmTokens): show an "Accept
  // predictions" affordance only when this sentence still has machine-made,
  // unverified material — on a span (lemma/xpos/upos/feats) or a relation.
  const hasInferred = useMemo(() => {
    const spanInferred = tokenData.some((d) =>
      isInferredSpan(d.lemma) || isInferredSpan(d.xpos) || isInferredSpan(d.upos)
      || (d.feats || []).some(isInferredSpan));
    return spanInferred || (relations || []).some((r) => provState(r.metadata) === PROV_STATES.MACHINE);
  }, [tokenData, relations]);

  const handleConfirmSentence = useCallback(() => {
    onConfirmTokens?.(tokenData.map((d) => d.token.id));
  }, [onConfirmTokens, tokenData]);

  // Ctrl/Cmd+Enter confirms just the focused token. The focused cell's input id
  // is `${tokenId}-${field}` — read it off the event target (the cell's own
  // Enter handler may blur before this bubbling handler runs, so activeElement
  // is unreliable, but e.target still points at the input).
  const handleContainerKeyDown = useCallback((e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    if (isReadOnly || !onConfirmTokens) return;
    const m = /^(.*)-(?:lemma|xpos|upos|feats)$/.exec(e.target?.id || '');
    if (m) {
      e.preventDefault();
      onConfirmTokens([m[1]]);
    }
  }, [isReadOnly, onConfirmTokens]);

  return (
    <div className="sentence-container" onKeyDown={handleContainerKeyDown}>
      {!isReadOnly && onConfirmTokens && hasInferred && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
          <Button
            size="compact-xs"
            variant="subtle"
            color="violet"
            leftSection={<IconCheck size={12} />}
            onClick={handleConfirmSentence}
            title="Mark every machine prediction in this sentence as reviewed. Ctrl+Enter on a cell confirms just that word."
          >
            Accept predictions
          </Button>
        </div>
      )}
      {/* Dependency tree visualization */}
      <DependencyTree
        ref={treeRef}
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
        onExitDown={focusGridCell}
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