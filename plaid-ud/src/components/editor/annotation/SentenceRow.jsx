import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { ChevronRight, Check, Undo2, PenLine } from 'lucide-react';
import { Combobox } from '@ui/components/ui/combobox';
import { Button } from '@ui/components/ui/button';
import { isMachine, needsReview, provState, PROV_STATES } from '@larc-iu/plaid-client';
import { DependencyTree } from './DependencyTree.jsx';
import { useTokenPositions } from '../hooks/useTokenPositions.js';
import { resolveColor } from '../../../utils/udVocab.js';
import { notifyWarning } from '../../../utils/notify.js';
import {
  readFieldProbs,
  groupSuggestions,
  probLabel,
  provCellTitle,
  provMark,
} from '../../../utils/provenanceUi.js';
import { MetadataFields } from '../../common/MetadataFields.jsx';
import { SentenceComments } from './SentenceComments.jsx';
import { metadataRows } from '../../../utils/udMetadata.js';
import './SentenceRow.css';

// Shared throttle for tab navigation across all EditableCell instances
let lastGlobalTabPress = 0;

// Fallback when no per-document visibility is supplied (e.g. historical view):
// show every annotation row. Stable reference so memoized children don't churn.
const ALL_FIELDS_VISIBLE = { lemma: true, xpos: true, upos: true, feats: true, meta: true };

// Stable empty-options reference: an idle vocab cell passes this instead of the
// real suggestion list, so a grid of a thousand cells doesn't rank and group a
// tag set per cell per render. Options are built only while the cell is
// focused/editing, which is the only time the list can be open.
const NO_OPTIONS = [];

// Stable empty reference for the project's declared sentence fields, so a
// sentence row memoized on its props doesn't churn when there are none.
const EMPTY_FIELDS = [];

// Editable cell component for annotation fields
const EditableCell = React.memo(
  ({
    value,
    tokenId,
    tokenIndex,
    field,
    tokenForm,
    tabIndex,
    columnWidth,
    onUpdate,
    onNavigate,
    isReadOnly,
    suggestions,
    cellColor,
    mark,
    provMeta,
    validate,
    descriptions,
    onPrecedent,
  }) => {
    const [localValue, setLocalValue] = useState(value || '');
    // Alt+Down replaces the cell's list with what the project has said before
    // about a word like this one, counts and all. Null means the ordinary list.
    const [precedent, setPrecedent] = useState(null);
    // What the input currently shows, readable synchronously. Enter in a vocab
    // cell takes the highlighted option and blurs in the same tick, and a blur
    // handler reading `localValue` would still see the prefix that was typed.
    const valueRef = useRef(localValue);
    const setValue = (next) => {
      valueRef.current = next;
      setLocalValue(next);
    };
    const [isEditing, setIsEditing] = useState(false);
    // `pristine` = focused but not yet typed: the vocab dropdown shows the full
    // list; the first keystroke flips it off so the list filters.
    const [pristine, setPristine] = useState(true);
    const inputRef = useRef(null);

    // Select-all on arrival, so the next keystroke replaces the cell rather than
    // appending to it. It has to be DEFERRED, because a click puts the caret in
    // after focus and would undo a selection made during it — and, being
    // deferred, it has to check that nothing has been typed in the meantime, or
    // a fast typist (or a test driving the keyboard) loses their first
    // character to it.
    const selectPendingRef = useRef(false);
    // Escape means cancel. The blur it fires must neither write the typed value
    // nor count as re-typing the machine's own (which would verify it), and a
    // flag is the only way to say so: `blur()` inside a key handler runs the
    // blur handler before React has committed anything set alongside it.
    const cancelledRef = useRef(false);
    const selectOnArrival = () => {
      selectPendingRef.current = true;
      setTimeout(() => {
        if (selectPendingRef.current) inputRef.current?.select();
      }, 0);
    };
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
        valueRef.current = value || '';
        setLocalValue(value || '');
      }
    }, [value]);

    const handleChange = (e) => {
      selectPendingRef.current = false;
      setValue(e.target.value);
      setPristine(false);
    };

    // A cell with no controlled list of its own (LEMMA) is a plain input, and
    // showing precedent turns it into a combobox. React unmounts the input to
    // do that, which fires a blur — one that must not be read as "the annotator
    // left", or the list would be cleared the instant it arrived and focus
    // would land on nothing.
    const swappingRef = useRef(false);

    // What this project has given words like this one. Asked on the gesture,
    // never on focus: it is a query per open, and most cells never want it.
    const askPrecedent = async () => {
      if (!onPrecedent) return false;
      const rows = await onPrecedent(field);
      // Nothing to show is not a mode worth entering: the cell keeps its list
      // and the annotator learns the answer by the list not changing.
      if (!rows?.length) return false;
      swappingRef.current = !suggestions?.length;
      setPrecedent(rows);
      setPristine(true);
      return true;
    };

    const handleBlur = () => {
      // The swap below unmounts this input; if that produced a blur it is not
      // the annotator leaving, and committing on it would commit nothing and
      // clear the list that was just asked for.
      if (swappingRef.current) return;
      setIsEditing(false);
      setPrecedent(null);
      if (cancelledRef.current) {
        cancelledRef.current = false;
        setValue(value || '');
        return;
      }
      const newValue = valueRef.current.trim();

      // A CLOSED vocabulary refuses a value that is not on its list. The
      // saved value is kept, not the typed one: an annotator who meant a tag
      // the project does not have wants to see what is actually stored, and a
      // maintainer can open the list up in two clicks. Enforced here and in the
      // Grew rewrite, and nowhere else — an import, a service, the assistant
      // and the API all still get through, which is what the Validation tab is
      // for.
      const refusal = validate?.(newValue);
      if (refusal) {
        notifyWarning(refusal, 'Not in the list');
        setValue(value || '');
        return;
      }

      const changed = newValue !== (value || '');
      // Re-typing a machine prediction's value is a human confirmation
      // (provenance write contract): commit it even though the value is the
      // same, so the span gets verified. `pristine` guards this to actual
      // typing — tabbing through a cell must not confirm anything.
      const retyped = !changed && !pristine && !!mark && !!newValue;
      if (changed || retyped) {
        onUpdate(tokenId, field, newValue || null).catch((error) => {
          console.error(`Failed to update ${field}:`, error);
          // Revert to original value on error
          setValue(value || '');
        });
      } else {
        // Revert to original if unchanged
        setValue(value || '');
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
        // Ctrl/Cmd+Enter is the per-token "accept predictions" gesture (handled by
        // the sentence container). Let it bubble and keep focus on this cell
        // rather than blurring.
        if (e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        inputRef.current?.blur();
        return;
      }
      if (e.key === 'Escape') {
        cancelledRef.current = true;
        setValue(value || '');
        setIsEditing(false);
        inputRef.current?.blur();
        return;
      }

      // Ctrl/Cmd+Shift+Up/Down is the review sweep (useReviewGestures, at the
      // document level, since it crosses sentences). Let it bubble untouched.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) return;

      if (e.key === 'ArrowDown' && e.altKey && onPrecedent) {
        e.preventDefault();
        askPrecedent();
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
      // The new element has focus, so the swap is over: from here a blur is the
      // annotator leaving and must commit. Clearing this on the BLUR instead
      // would never happen — React fires none when it unmounts a focused
      // element — and the next real blur would be swallowed silently.
      swappingRef.current = false;
      setIsEditing(true);
      setPristine(true);
      selectOnArrival();
    };

    const displayValue =
      localValue || (field === 'lemma' && !value && !isReadOnly ? tokenForm : '');
    const hasContent = displayValue && displayValue.trim() !== '';
    const fieldClass =
      `editable-field ${hasContent ? 'editable-field--filled' : 'editable-field--empty'}` +
      (mark && hasContent ? ` editable-field--${mark}` : '');

    // An unreviewed cell wears its provenance hue, NOT the per-value colour a
    // UPOS tag carries: "nobody has looked at this" outranks "this is a NOUN",
    // and the tag's colour comes back the moment the mark clears. Without this
    // the two marks would be told apart only by the underline tint on exactly
    // the row a parser writes most. The dependency tree already resolves the
    // same clash the same way (see PROV_MARK_COLORS in DependencyTree).
    //
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
            ...(hasContent && cellColor && !mark ? { color: cellColor } : {}),
          }}
          title={provCellTitle(field, provMeta)}
        >
          {hasContent ? displayValue : ' '}
        </div>
      );
    }

    // Vocab cells (UPOS/XPOS) use a Combobox: focusing opens the FULL controlled
    // list and it filters only once the user starts typing (the custom `pristine`
    // filter). Off-list values are still accepted (soft). It reuses the
    // `.editable-field` styling so it matches the grid, and has no native picker
    // arrow (which is what shifted the datalist's centered text off-center).
    // When the producing parser recorded a distribution, its top-k floats above
    // the rest as a "Parser suggestions" group, with the probability rendered as
    // a dimmed suffix (renderOption only — the committed value stays the bare tag).
    // A cell showing PRECEDENT is a combobox whichever field it is: a lemma
    // cell has no controlled list of its own and is a plain input the rest of
    // the time, but Alt+Down gives it one to show.
    if (!isReadOnly && (precedent || (suggestions && suggestions.length))) {
      // Group-aware pristine filter: the data may be flat or grouped.
      const filterItems = (items, q) => items.filter((o) => o.label.toLowerCase().includes(q));
      const optionsFilter = ({ options, search }) => {
        if (precedent || pristine) return options;
        const q = search.toLowerCase().trim();
        return options
          .map((o) => ('group' in o ? { ...o, items: filterItems(o.items, q) } : o))
          .filter((o) => ('group' in o ? o.items.length > 0 : o.label.toLowerCase().includes(q)));
      };
      // Commit the picked tag and leave, from a click or from Enter. The value
      // goes through the ref-backed setter so the blur this triggers reads the
      // tag and not the prefix that was typed to find it.
      const takeOption = (picked) => {
        setValue(picked);
        inputRef.current?.blur();
      };
      return (
        <Combobox
          ref={inputRef}
          id={`${tokenId}-${field}`}
          spellCheck={false}
          // The cell's saved value, so the document-level Ctrl/Cmd+Backspace
          // can tell an untouched cell from one with unsaved typing in it and
          // leave the browser's delete-a-word alone in the second case.
          data-orig={value || ''}
          options={
            precedent
              ? precedent.map((row) => ({ value: row.value, label: row.value }))
              : isEditing
                ? groupSuggestions(suggestions, fieldProbs)
                : NO_OPTIONS
          }
          renderOption={
            precedent
              ? ({ option }) => {
                  const row = precedent.find((r) => r.value === option.value);
                  return (
                    <span>
                      {option.value}
                      {row && (
                        <span style={{ opacity: 0.55, marginLeft: 8, fontSize: '0.85em' }}>
                          {row.count}
                        </span>
                      )}
                    </span>
                  );
                }
              : fieldProbs || descriptions
                ? ({ option }) => {
                    const pct = probLabel(fieldProbs, option.value);
                    // What the tag MEANS, beside it. The whole reason to seed the
                    // universal sets with definitions is that a picker is where
                    // the question "which of these is it" gets asked.
                    const gloss = descriptions?.[option.value];
                    return (
                      <span>
                        {option.value}
                        {pct && (
                          <span style={{ opacity: 0.55, marginLeft: 6, fontSize: '0.85em' }}>
                            {pct}
                          </span>
                        )}
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
          value={displayValue}
          onChange={(val) => {
            selectPendingRef.current = false;
            setValue(val);
            setPristine(false);
            // Typing leaves the precedent list: what the project did before is
            // an answer to "what have we called this", not a filter.
            setPrecedent(null);
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onSubmit={takeOption}
          onKeyDown={(e, combo) => {
            // Arrows belong to the grid until the user has TYPED into this cell:
            // focusing opens the full list, and arrows on a pristine cell keep
            // moving through the grid; once typing has filtered the list, the
            // arrows browse it (Enter picks). The combobox hands us that state
            // rather than leaving us to read it off the DOM.
            // While precedent is showing, the list IS the point: arrows browse
            // it from the first keystroke, not only once something is typed.
            const browsing = precedent ? combo.open : !pristine && combo.open;
            // Ctrl/Cmd+Shift+Up/Down is the review sweep, handled at the
            // document level. Never let it browse the tag list.
            if ((e.ctrlKey || e.metaKey) && e.shiftKey) return;
            if (e.key === 'ArrowDown' && e.altKey && onPrecedent) {
              e.preventDefault();
              askPrecedent();
              return;
            }
            if (e.key === 'Escape' && precedent) {
              e.preventDefault();
              setPrecedent(null);
              return;
            }
            if (e.key === 'Tab') {
              const now = Date.now();
              if (now - lastGlobalTabPress < 55) {
                e.preventDefault();
              } else {
                lastGlobalTabPress = now;
              }
              return;
            }
            if (e.key === 'Enter') {
              // Ctrl/Cmd+Enter is the per-token accept gesture (container
              // handler): let it bubble and keep focus here.
              if (e.ctrlKey || e.metaKey) return;
              e.preventDefault();
              takeOption(combo.activeValue ?? valueRef.current);
              return;
            }
            if (e.key === 'Escape') {
              // Reverts and leaves the cell, list open or not. Not
              // preventDefault-ed, so the list closes on the way out.
              cancelledRef.current = true;
              setValue(value || '');
              inputRef.current?.blur();
              return;
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              if (
                !browsing &&
                onNavigate?.(field, tokenIndex, e.key === 'ArrowUp' ? 'up' : 'down')
              ) {
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
          // Arriving from the swap above: the input is a new element, so focus
          // has to be asked for. Harmless on a cell that was already a
          // combobox, which has focus already.
          autoFocus={!!precedent}
          autoHighlight={false}
          tabIndex={tabIndex}
          title={cellTitle}
          className={fieldClass}
          style={{
            width: columnWidth ? `${columnWidth}px` : 'auto',
            ...(hasContent && cellColor && !mark ? { color: cellColor } : {}),
          }}
          optionClassName="px-2 py-0.5 text-xs"
        />
      );
    }

    return (
      <input
        ref={inputRef}
        id={`${tokenId}-${field}`}
        type="text"
        spellCheck={false}
        data-orig={value || ''}
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        className={fieldClass}
        style={{
          width: columnWidth ? `${columnWidth}px` : 'auto',
          ...(hasContent && cellColor && !mark ? { color: cellColor } : {}),
        }}
        title={cellTitle}
        tabIndex={tabIndex}
      />
    );
  },
);

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
const FeaturesCell = React.memo(
  ({
    features,
    featureMarks,
    validate,
    spanIds,
    tokenId,
    tokenIndex,
    tabIndex,
    columnWidth,
    onAnnotationUpdate,
    onFeatureDelete,
    onNavigate,
    featureInventory,
    isReadOnly,
  }) => {
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

    const commit = (raw) => {
      const t = (raw ?? text).trim();
      const i = t.indexOf('=');
      if (i <= 0 || i === t.length - 1) return false; // need non-empty Key=Value
      // A CLOSED inventory governs both halves: the key must be in it and the
      // value in that key's list. The typed text is KEPT here, unlike a cell:
      // a chip is added rather than replacing something, so there is nothing
      // to restore and the annotator can correct what they typed.
      const refusal = validate?.(t);
      if (refusal) {
        notifyWarning(refusal, 'Not in the inventory');
        return false;
      }
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
        const now = Date.now();
        if (now - lastGlobalTabPress < 55) {
          e.preventDefault();
          return;
        }
        lastGlobalTabPress = now;
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
        // Ctrl/Cmd+Enter confirms the whole token (container handler) — don't also
        // commit a (possibly empty) feature, and keep focus on this cell.
        if (e.ctrlKey || e.metaKey) return;
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
        if (!dropdownOpen) {
          cancelledRef.current = true;
          setText('');
          input?.blur();
        }
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
              } else if (!commit()) {
                setText('');
              }
            }}
            onSubmit={takeOption}
            onKeyDown={handleKeyDown}
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

// Token Column component
const TokenColumn = React.memo(
  ({
    data,
    index,
    columnWidth,
    getTabIndex,
    onAnnotationUpdate,
    onFeatureDelete,
    onNavigate,
    onConfirmTokens,
    maxFeatures,
    tokenRefs,
    isReadOnly,
    vocab,
    uposColors,
    featureInventory,
    visibleFields,
    relationInferred,
    reviewable,
    validators,
    descriptions,
    onPrecedent,
  }) => {
    // This word still has machine predictions a human hasn't reviewed (a span on
    // it, or its incoming dependency relation — confirmTokens covers both). When so, a
    // ✓ reveals while you're on THIS word — discoverable at the moment, teaching
    // the Ctrl+Enter shortcut (tooltip). Keyboard focus reveals it via CSS
    // (:focus-within); mouse reveal is JS with a short close-delay so the ✓
    // survives the trip up across the dependency tree's SVG (which otherwise drops
    // a pure-CSS column hover before you can reach it).
    const wordInferred =
      relationInferred ||
      [data.form, data.lemma, data.xpos, data.upos, ...(data.feats || [])].some(
        (span) => !!span && reviewable(span.metadata),
      );
    const showCheck = !isReadOnly && onConfirmTokens && wordInferred;
    const [hoverShow, setHoverShow] = useState(false);
    const hideTimer = useRef(null);
    useEffect(
      () => () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
      },
      [],
    );
    const revealCheck = () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setHoverShow(true);
    };
    const hideCheckSoon = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setHoverShow(false), 250);
    };

    return (
      <div
        className="token-column"
        style={{ width: `${columnWidth}px` }}
        onMouseEnter={showCheck ? revealCheck : undefined}
        onMouseLeave={showCheck ? hideCheckSoon : undefined}
      >
        {/* A native title rather than a tooltip primitive: there is one of these
            per word in a grid that runs to thousands, and every other affordance
            in the grid (each cell, the sentence-level Accept) explains itself the
            same way. */}
        {showCheck && (
          <button
            type="button"
            className="word-accept"
            data-show={hoverShow || undefined}
            tabIndex={-1}
            title="Accept this word's predictions (Ctrl/Cmd+Enter)"
            aria-label="Accept this word's predictions"
            onClick={() => onConfirmTokens([data.token.id])}
          >
            <Check width={12} height={12} />
          </button>
        )}
        {/* Token form (baseline). An unreviewed Form span (MWT components from
            the parser) gets the same marking as the cells. */}
        <div
          className={`token-form${provMark(data.form?.metadata) ? ` token-form--${provMark(data.form.metadata)}` : ''}`}
          title={
            provState(data.form?.metadata) === PROV_STATES.HUMAN
              ? undefined
              : provCellTitle('Form', data.form.metadata)
          }
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
              mark={provMark(data.lemma?.metadata)}
              onPrecedent={onPrecedent}
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
              mark={provMark(data.xpos?.metadata)}
              validate={validators?.xpos}
              descriptions={descriptions?.xpos}
              onPrecedent={onPrecedent}
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
              mark={provMark(data.upos?.metadata)}
              validate={validators?.upos}
              descriptions={descriptions?.upos}
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
              features={data.feats.map((feat) => feat.value)}
              featureMarks={data.feats.map((f) => provMark(f?.metadata))}
              validate={validators?.feats}
              spanIds={{
                features: data.spanIds.features,
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
  },
  (prevProps, nextProps) => {
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
      prevProps.relationInferred === nextProps.relationInferred &&
      // Stable per contributor id (doc.writer memoizes the policy).
      prevProps.reviewable === nextProps.reviewable &&
      // Stable per layerInfo version, like vocab below.
      prevProps.validators === nextProps.validators &&
      prevProps.descriptions === nextProps.descriptions &&
      prevProps.onPrecedent === nextProps.onPrecedent &&
      // Stable identity per layerInfo version, so these don't trigger re-renders.
      prevProps.vocab === nextProps.vocab &&
      prevProps.uposColors === nextProps.uposColors &&
      prevProps.featureInventory === nextProps.featureInventory &&
      prevProps.visibleFields === nextProps.visibleFields
    );
  },
);

// Clickable row header (LEMMA/XPOS/UPOS/FEATS). Always shown so a collapsed row
// can be re-expanded; the leading chevron reflects state (rotated down = expanded,
// pointing right = collapsed).
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
        <ChevronRight
          width={12}
          height={12}
          className="row-label__chevron"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms ease',
          }}
        />
      )}
      {label}
    </div>
  );
};

export const SentenceRow = React.memo(
  ({
    sentenceData,
    onAnnotationUpdate,
    onFeatureDelete,
    onRelationCreate,
    onRelationUpdate,
    onRelationDelete,
    onConfirmTokens,
    onDiscardTokens,
    onSentenceMetadata,
    onEditText,
    comments,
    commentAnchorLabel,
    canComment,
    canDeleteAnyComment,
    validators,
    descriptions,
    onPrecedent,
    sentenceFields = EMPTY_FIELDS,
    reviewable = needsReview,
    totalTokensBefore = 0,
    vocab,
    colors,
    visibleFields = ALL_FIELDS_VISIBLE,
    onToggleField,
  }) => {
    // Token data is already pre-processed in sentenceData
    const tokenData = sentenceData.tokens;

    // Calculate column widths based on max content width
    const columnWidths = useMemo(() => {
      const widths = tokenData.map((data) => {
        const charWidth = 8; // Approximate width per character
        const padding = 16; // Account for padding
        const minWidth = 40; // Minimum width

        // Token form row is always shown, so it always contributes width.
        const candidates = [minWidth, data.tokenForm.length * charWidth + padding];

        // Only let a field widen the column when it's actually visible — hiding
        // FEATS in particular collapses the over-wide columns it would force.
        if (visibleFields.lemma)
          candidates.push((data.lemma?.value || data.tokenForm).length * charWidth + padding);
        if (visibleFields.xpos)
          candidates.push((data.xpos?.value || '').length * charWidth + padding);
        if (visibleFields.upos)
          candidates.push((data.upos?.value || '').length * charWidth + padding);
        if (visibleFields.feats) {
          const longestFeature = data.feats.reduce((longest, feat) => {
            return feat.value && feat.value.length > longest.length ? feat.value : longest;
          }, '');
          candidates.push(longestFeature ? longestFeature.length * charWidth + padding : minWidth);
        }

        // Return max width for this column
        return Math.max(...candidates);
      });

      return widths;
    }, [tokenData, visibleFields]);

    // Calculate the maximum number of features across all tokens for row height
    const maxFeatures = Math.max(1, ...tokenData.map((data) => data.feats.length));
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
        const matchingToken = tokenData.find((t) => t.token.begin === begin && t.token.end === end);
        return matchingToken ? matchingToken.tokenForm : '';
      },
    };

    // Use the token positions hook
    const { tokenPositions, sentenceGridRef, tokenRefs } = useTokenPositions(tokenData, lemmaSpans);

    // Imperative handle into this sentence's dependency tree, for the arrow
    // handoff between the grid and the deprel labels.
    const treeRef = useRef(null);

    // Detect if we're in read-only mode (historical state)
    const isReadOnly = onAnnotationUpdate === null;

    // Calculate tab indices for row-wise navigation across all sentences
    const getTabIndex = useCallback(
      (tokenIndex, field) => {
        const fieldOrder = { lemma: 0, xpos: 1, upos: 2, feats: 3 };
        const tokensInSentence = tokenData.length;

        // Calculate base index for this sentence (all previous sentences)
        const sentenceBaseIndex = totalTokensBefore * 4;

        // Row-wise: field type determines row, token index determines position in row
        const rowIndex = fieldOrder[field];
        const positionInRow = tokenIndex;

        return sentenceBaseIndex + rowIndex * tokensInSentence + positionInRow + 1;
      },
      [tokenData.length, totalTokensBefore],
    );

    // Arrow-key navigation within the sentence's annotation grid.
    // Up/Down step through LEMMA → XPOS → UPOS → FEATS for a fixed token
    // column; Left/Right step through tokens at a fixed field. Every cell's
    // focusable input carries the id `${tokenId}-${field}` (FEATS included —
    // its chip input is `${tokenId}-feats`).
    // Returns true on a successful focus shift so the caller can preventDefault.
    // Hidden rows are excluded so Up/Down skips over them rather than dead-ending.
    const NAV_FIELDS = useMemo(
      () => ['lemma', 'xpos', 'upos', 'feats'].filter((f) => visibleFields[f]),
      [visibleFields],
    );
    const onNavigate = useCallback(
      (field, tokenIndex, dir) => {
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
      },
      [tokenData, NAV_FIELDS],
    );

    // ArrowDown out of a deprel label lands on that dependent token's top
    // (first visible) annotation cell — the mirror of the ArrowUp handoff above.
    const focusGridCell = useCallback(
      (tokenId) => {
        const top = NAV_FIELDS[0];
        if (!top) return;
        document.getElementById(`${tokenId}-${top}`)?.focus();
      },
      [NAV_FIELDS],
    );

    // Provenance review: whether this sentence still holds material worth a
    // gesture — on a span (form/lemma/xpos/upos/feats) or a relation.
    //
    // Two scopes, and they are not the same. ACCEPT acts on what this writer
    // reviews (a verifier reviews machine and contributed material, a
    // contributor machine proposals only), so `reviewable` is the writer
    // policy's own predicate. DISCARD acts on MACHINE material whoever is
    // looking: see ConlluDocument.discardTokens for why a contributor's work is
    // never thrown away by a keyboard chord.
    const holds = useCallback(
      (predicate) => {
        const onSpans = tokenData.some((d) =>
          [d.form, d.lemma, d.xpos, d.upos, ...(d.feats || [])].some(
            (span) => !!span && predicate(span.metadata),
          ),
        );
        return onSpans || (relations || []).some((r) => predicate(r.metadata));
      },
      [tokenData, relations],
    );
    const hasInferred = useMemo(() => holds(reviewable), [holds, reviewable]);
    const hasMachine = useMemo(() => holds(isMachine), [holds]);

    // Tokens whose incoming dependency relation still needs this writer's look
    // (the dependent is the relation's TARGET lemma span), for the per-word ✓.
    const inferredRelTokenIds = useMemo(() => {
      const tokenByLemma = new Map();
      for (const d of tokenData) if (d.lemma?.id) tokenByLemma.set(d.lemma.id, d.token.id);
      const ids = new Set();
      for (const r of relations || []) {
        if (!reviewable(r.metadata)) continue;
        const tokenId = tokenByLemma.get(r.target);
        if (tokenId) ids.add(tokenId);
      }
      return ids;
    }, [tokenData, relations, reviewable]);

    const handleConfirmSentence = useCallback(() => {
      onConfirmTokens?.(tokenData.map((d) => d.token.id));
    }, [onConfirmTokens, tokenData]);

    const handleDiscardSentence = useCallback(() => {
      onDiscardTokens?.(tokenData.map((d) => d.token.id));
    }, [onDiscardTokens, tokenData]);

    // The sentence's own notes: sent_id, whatever the project declares, and
    // whatever is already stored that it no longer does. They live on the
    // SENTENCE TOKEN, which is where CoNLL-U's `# k = v` lines have always been
    // read from and written back to.
    const sentenceToken = sentenceData.sentenceToken;
    const sentenceMeta = sentenceToken?.metadata;
    const metaRows = useMemo(
      () => metadataRows(sentenceFields, sentenceMeta, 'sentence'),
      [sentenceFields, sentenceMeta],
    );
    const handleSentenceMetadata = useCallback(
      (key, value) => onSentenceMetadata?.(sentenceToken?.id, key, value),
      [onSentenceMetadata, sentenceToken],
    );

    // Hand over to the Text Editor at this sentence, the mirror of Alt+click on
    // a token there. Undefined when there is no sentence token to land on, so
    // the affordance is simply absent rather than inert.
    const handleEditText = useMemo(
      () => (onEditText && sentenceToken?.id ? () => onEditText(sentenceToken.id) : undefined),
      [onEditText, sentenceToken],
    );

    return (
      <div className="sentence-container">
        {/* Dependency tree visualization */}
        <DependencyTree
          ref={treeRef}
          tokens={sentenceData.tokens.map((t) => t.token)}
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
          onEditText={handleEditText}
          validateDeprel={validators?.deprel}
          deprelDescriptions={descriptions?.deprel}
        />

        {/* Main container with labels and columns */}
        <div className="sentence-grid" ref={sentenceGridRef}>
          {/* Labels column */}
          <div className="labels-column">
            {/* Empty space for token form row */}
            <div className="label-spacer"></div>

            {/* Row headers — always visible, click to expand/collapse */}
            <RowLabelHeader
              field="lemma"
              label="LEMMA"
              expanded={visibleFields.lemma}
              onToggle={onToggleField}
            />
            <RowLabelHeader
              field="xpos"
              label="XPOS"
              expanded={visibleFields.xpos}
              onToggle={onToggleField}
            />
            <RowLabelHeader
              field="upos"
              label="UPOS"
              expanded={visibleFields.upos}
              onToggle={onToggleField}
            />
            <RowLabelHeader
              field="feats"
              label="FEATS"
              expanded={visibleFields.feats}
              onToggle={onToggleField}
              style={
                visibleFields.feats
                  ? {
                      minHeight: `${featsExpandedHeight}px`,
                      alignItems: 'flex-start',
                      paddingTop: '6px',
                    }
                  : undefined
              }
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
              onConfirmTokens={onConfirmTokens}
              maxFeatures={maxFeatures}
              tokenRefs={tokenRefs}
              isReadOnly={isReadOnly}
              vocab={vocab}
              uposColors={colors?.upos}
              featureInventory={vocab?.featureInventory}
              visibleFields={visibleFields}
              relationInferred={inferredRelTokenIds.has(data.token.id)}
              reviewable={reviewable}
              validators={validators}
              descriptions={descriptions}
              onPrecedent={onPrecedent ? (field) => onPrecedent(field, data) : undefined}
            />
          ))}
        </div>

        {/* The sentence's own notes, under its grid and behind the same chevron
          disclosure the annotation rows use, so expanding it once expands it
          for the whole document. Collapsed by default: sent_id is housekeeping
          most of the time, and a strip per sentence would crowd the grid it
          belongs to. It sits below rather than above because the dependency
          tree is absolutely positioned over the top of this container. */}
        {metaRows.length > 0 && (
          <div className="sentence-meta">
            <div
              className="row-label row-label--toggle sentence-meta__toggle"
              role="button"
              tabIndex={-1}
              title={`${visibleFields.meta ? 'Hide' : 'Show'} sentence fields`}
              onClick={() => onToggleField?.('meta')}
            >
              <ChevronRight
                width={12}
                height={12}
                className="row-label__chevron"
                style={{
                  transform: visibleFields.meta ? 'rotate(90deg)' : 'none',
                  transition: 'transform 150ms ease',
                }}
              />
              SENTENCE
              {!visibleFields.meta && sentenceMeta?.sent_id && (
                <span className="sentence-meta__summary">{sentenceMeta.sent_id}</span>
              )}
            </div>
            {visibleFields.meta && (
              <div className="sentence-meta__fields">
                <MetadataFields
                  rows={metaRows}
                  values={sentenceMeta}
                  readOnly={isReadOnly || !onSentenceMetadata}
                  dense
                  onCommit={handleSentenceMetadata}
                />
              </div>
            )}
          </div>
        )}

        {/* The sentence's own review gestures — BELOW the grid and left-aligned
          with the first token, so they read as belonging to this sentence.
          Accept takes everything proposed, Discard throws the machine's
          proposals away, and each shows only when it has something to do. */}
        {(handleEditText || comments || (!isReadOnly && (hasInferred || hasMachine))) && (
          <div className="sentence-confirm">
            {!isReadOnly && onConfirmTokens && hasInferred && (
              <Button
                className="accept-predictions-btn h-6 gap-1 px-2 text-xs"
                variant="outline"
                onClick={handleConfirmSentence}
                title="Accept every proposal in this sentence as it stands. Ctrl/Cmd+Enter does one word."
              >
                <Check width={12} height={12} />
                Accept predictions
              </Button>
            )}
            {!isReadOnly && onDiscardTokens && hasMachine && (
              <Button
                className="discard-predictions-btn h-6 gap-1 px-2 text-xs"
                variant="outline"
                onClick={handleDiscardSentence}
                title="Delete every machine annotation in this sentence that nobody has confirmed. Ctrl/Cmd+Backspace does one word."
              >
                <Undo2 width={12} height={12} />
                Discard predictions
              </Button>
            )}
            {handleEditText && (
              <Button
                className="edit-text-btn h-6 gap-1 px-2 text-xs"
                variant="ghost"
                onClick={handleEditText}
                title="Open this sentence in the Text Editor. Alt+click a word does the same."
              >
                <PenLine width={12} height={12} />
                Edit text
              </Button>
            )}
            {comments && sentenceToken?.id && (
              <SentenceComments
                store={comments}
                sentenceId={sentenceToken.id}
                anchorLabel={commentAnchorLabel}
                canWrite={canComment}
                canDeleteAny={canDeleteAnyComment}
              />
            )}
          </div>
        )}
      </div>
    );
  },
);
