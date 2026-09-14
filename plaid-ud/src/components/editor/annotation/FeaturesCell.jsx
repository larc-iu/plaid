import React, { useState, useRef } from 'react';
import { Combobox } from '@ui/components/shared/combobox';
import { featureRefusal, normalizeFeature } from '../../../utils/feats.js';
import { notifyWarning } from '../../../utils/feedback.jsx';
import { provMark } from '../../../utils/provenanceUi.js';
import { NO_OPTIONS, tabTooSoon } from './cellInput.js';
import { useEditorSession } from './editorSession.js';

// Features cell component with hover-only delete buttons
// FEATS is a token-field (chip input): the cell IS one slim input, with the
// feature pills stacked above it. Arriving (Tab / arrows / click) focuses the
// input directly, so adding is just typing — suggestions offer inventory keys
// ("Case=") until '=' is typed, then that key's values; a pair the inventory
// does not have is allowed unless the project has CLOSED it (`validators.feats`
// refuses it then, and the typed text stays), and committing an existing key
// overwrites it
// (domain semantics in updateAnnotation). Keyboard deletion is the classic
// chip-input gesture: Backspace at an empty input selects the last pill,
// Left/Right move the selection, Backspace/Delete remove it, typing or Escape
// clears it. Left/Right at an empty input with no selection fall through to
// grid column navigation, like every other cell.
export const FeaturesCell = React.memo(
  ({ feats, spanIds, tokenId, tokenIndex, tabIndex, columnWidth, onNavigate }) => {
    const session = useEditorSession();
    const { isReadOnly, onAnnotationUpdate, onFeatureDelete } = session;
    const validate = session.validators?.feats;
    const featureInventory = session.vocab?.featureInventory;
    const featureDescriptions = session.descriptions?.feats;
    // The word's FEATS spans as this cell reads them: the pills it draws, and
    // how each one came to be there.
    const features = feats.map((feat) => feat.value);
    const featureMarks = feats.map((feat) => provMark(feat?.metadata));

    const [text, setText] = useState('');
    const [selectedPill, setSelectedPill] = useState(null); // index into features, or null
    const [isEditing, setIsEditing] = useState(false);
    const [hoveredFeatureIndex, setHoveredFeatureIndex] = useState(null);
    const inputRef = useRef(null);
    // As in EditableCell: Escape cancels, and the blur it fires reads the text
    // React has committed, not the text Escape just cleared.
    const cancelledRef = useRef(false);

    const inv = featureInventory || { list: [], map: new Map() };

    // Two-stage suggestions: keys (as "Key=") until '=' is typed, then values.
    const eqIdx = text.indexOf('=');
    const suggestions =
      eqIdx === -1
        ? inv.list.map((e) => `${e.key}=`)
        : (inv.map.get(text.slice(0, eqIdx).trim()) || []).map(
            (v) => `${text.slice(0, eqIdx)}=${v}`,
          );

    // `true` when it committed, `'refused'` when a closed inventory turned the
    // value down, `false` when there was nothing complete to commit. The three
    // are not the same on the way out: a fragment is dropped, a refusal is
    // kept. Both returning false meant Enter kept the text the ruling says to
    // keep and clicking away wiped it, with the same warning either way.
    const commit = (raw) => {
      // One reading of the pair for the cell, the document and the importer
      // alike (utils/feats.js), both halves trimmed.
      const feature = normalizeFeature(raw ?? text);
      if (!feature) return false; // need non-empty Key=Value
      // The typed text is KEPT on a refusal, unlike in a cell: a chip is added
      // rather than replacing something, so there is nothing to restore and the
      // annotator can correct what they typed.
      const spaced = featureRefusal(feature.pair);
      if (spaced) {
        notifyWarning(spaced, 'Spaces in a feature');
        return 'refused';
      }
      // A CLOSED inventory governs both halves: the key must be in it and the
      // value in that key's list.
      const refusal = validate?.(feature.pair);
      if (refusal) {
        notifyWarning(refusal, 'Not in the inventory');
        return 'refused';
      }
      setText('');
      onAnnotationUpdate(tokenId, 'features', feature.pair).catch((error) => {
        console.error('Failed to add feature:', error);
      });
      return true;
    };

    const removePill = (index) => {
      const featureSpanInfo = spanIds?.[index];
      setSelectedPill(null);
      if (!featureSpanInfo) {
        console.error('No span ID found for feature at index', index);
        return;
      }
      onFeatureDelete(featureSpanInfo.spanId).catch((error) => {
        console.error('Failed to remove feature:', error);
      });
    };

    // A picked suggestion: a bare "Key=" just fills the input (keep typing the
    // value), a full "Key=Value" commits. Shared by the click and by Enter.
    const takeOption = (option) => {
      if (option.endsWith('=')) setText(option);
      else commit(option);
    };

    const handleKeyDown = (e, combo) => {
      // The document-level review gestures (Ctrl/Cmd+Enter, Ctrl/Cmd+Backspace,
      // Ctrl/Cmd+Shift+Up/Down) own these chords. Enter is the exception: it is
      // let through below so the cell can decline to commit a half-typed
      // feature on its way out.
      if ((e.ctrlKey || e.metaKey) && e.key !== 'Enter') return;
      if (e.key === 'Tab') {
        if (tabTooSoon()) e.preventDefault();
        return;
      }
      const input = inputRef.current;
      const empty = !text;
      // While the dropdown is open, Enter and the vertical arrows belong to the
      // list, not to the grid. An EMPTY input counts as closed: focusing opens
      // the key list, but arrows on an untouched cell should keep moving through
      // the grid, like the UPOS/XPOS cells; typing is what hands them over.
      const dropdownOpen = !empty && combo.open;

      if (e.key === 'Enter') {
        // Ctrl/Cmd+Enter confirms the whole token, handled by the one onKeyDown
        // above the whole sentence list (useReviewGestures). Don't also commit a
        // half-typed feature: returning without preventDefault handed the key to
        // the combobox, which auto-highlights as soon as anything is typed, so
        // reviewing a word with "Ca" in the box wrote Case=Nom. The gesture does
        // not read defaultPrevented, so it still confirms the token. What WOULD
        // stop it is stopPropagation: it only ever sees this event on its way up.
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        if (dropdownOpen && combo.activeValue != null) takeOption(combo.activeValue);
        else commit();
        return;
      }
      if (e.key === 'Escape') {
        if (selectedPill != null) {
          e.preventDefault();
          setSelectedPill(null);
          return;
        }
        // Escape cancels the cell whether or not the suggestion list is open,
        // as in EditableCell, and the combobox closes the list beside it.
        // Gated on the list, an exact match kept it open, so the first Escape
        // over a typed pair only closed the list and the Tab after it reached
        // the blur with nothing cancelled and wrote the pair.
        cancelledRef.current = true;
        setText('');
        input?.blur();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedPill != null) {
          e.preventDefault();
          removePill(selectedPill);
          return;
        }
        if (e.key === 'Backspace' && empty && features.length > 0) {
          e.preventDefault();
          setSelectedPill(features.length - 1);
        }
        return;
      }
      if (e.key === 'ArrowLeft') {
        if (selectedPill != null) {
          e.preventDefault();
          setSelectedPill(Math.max(0, selectedPill - 1));
          return;
        }
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
            className={`feature-tag ${
              selectedPill === index
                ? 'feature-tag--selected'
                : hoveredFeatureIndex === index
                  ? 'feature-tag--hovered'
                  : 'feature-tag--normal'
            }`}
            onMouseEnter={() => setHoveredFeatureIndex(index)}
            onMouseLeave={() => setHoveredFeatureIndex(null)}
            onClick={
              isReadOnly
                ? undefined
                : () => {
                    setSelectedPill(index);
                    inputRef.current?.focus();
                  }
            }
          >
            <span
              className={`feature-text${featureMarks?.[index] ? ` feature-text--${featureMarks[index]}` : ''}`}
            >
              {feature}
            </span>
            {!isReadOnly && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removePill(index);
                }}
                className={`feature-delete-btn ${hoveredFeatureIndex === index || selectedPill === index ? 'feature-delete-btn--visible' : 'feature-delete-btn--hidden'}`}
                title="Remove feature"
                tabIndex={-1}
              >
                ×
              </button>
            )}
          </div>
        ))}

        {!isReadOnly && (
          <Combobox
            ref={inputRef}
            id={`${tokenId}-feats`}
            spellCheck={false}
            options={isEditing ? suggestions : NO_OPTIONS}
            value={text}
            onChange={(val) => {
              setText(val);
              setSelectedPill(null);
            }}
            onFocus={() => setIsEditing(true)}
            onBlur={() => {
              // Commit a complete Key=Value on the way out; discard fragments.
              setIsEditing(false);
              setSelectedPill(null);
              if (cancelledRef.current) {
                cancelledRef.current = false;
                setText('');
              } else if (commit() === false) {
                setText('');
              }
            }}
            onSubmit={takeOption}
            onKeyDown={handleKeyDown}
            // What the pair MEANS, beside it, the same way the tag pickers do
            // it. Keyed by the whole `Key=Value`, which is what a span stores.
            renderOption={
              featureDescriptions
                ? ({ option }) => {
                    const gloss = featureDescriptions[option.value];
                    return (
                      <span>
                        {option.value}
                        {gloss && (
                          <span style={{ opacity: 0.6, marginLeft: 8, fontSize: '0.85em' }}>
                            {gloss}
                          </span>
                        )}
                      </span>
                    );
                  }
                : undefined
            }
            // Auto-highlight the best match once typing starts, so Enter takes
            // it. Gated on input so Enter on an EMPTY cell doesn't insert the
            // first inventory key.
            autoHighlight={text.length > 0}
            tabIndex={tabIndex}
            placeholder="+"
            title="Add feature (Key=Value)"
            // Always empty when untouched, so Ctrl/Cmd+Backspace over it is the
            // word's discard gesture and, once something is typed, the
            // browser's delete-a-word.
            data-orig=""
            className="feature-chip-input"
            optionClassName="px-2 py-0.5 text-xs"
          />
        )}
      </div>
    );
  },
);
