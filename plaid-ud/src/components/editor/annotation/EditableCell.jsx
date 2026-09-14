import React, { useState, useRef, useEffect } from 'react';
import { Combobox } from '@ui/components/shared/combobox';
import { notifyWarning } from '../../../utils/notify.js';
import {
  readFieldProbs,
  groupSuggestions,
  probLabel,
  provCellTitle,
  provMark,
} from '../../../utils/provenanceUi.js';
import { NO_OPTIONS, tabTooSoon } from './cellInput.js';
import { useEditorSession, controlledField } from './editorSession.js';
import { textIncludes } from '@ui/domain/collation.js';

// Editable cell component for annotation fields
export const EditableCell = React.memo(
  ({
    value,
    tokenId,
    tokenIndex,
    field,
    tokenForm,
    tabIndex,
    columnWidth,
    cellColor,
    provMeta,
    onNavigate,
    onPrecedent,
  }) => {
    // Everything below is the same for every cell in the document, so it comes
    // from the session rather than down four levels of props. Which fields have
    // a controlled list at all is `CONTROLLED_FIELDS`, not whichever keys the
    // project's config happens to carry: a cell on a field outside it (LEMMA)
    // stays a plain input whatever the config says.
    const session = useEditorSession();
    const { isReadOnly, onAnnotationUpdate: onUpdate } = session;
    const { suggestions, validate, descriptions } = controlledField(session, field);
    // How this cell's value came to be there, from the same metadata the
    // tooltip below reads.
    const mark = provMark(provMeta);

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
    // after focus and would undo a selection made during it: and, being
    // deferred, it has to check that nothing has been typed in the meantime, or
    // a fast typist (or a test driving the keyboard) loses their first
    // character to it.
    const selectPendingRef = useRef(false);
    // Did the annotator actually put something into this cell, by typing or by
    // picking? `pristine` cannot answer that: it also drives the dropdown's
    // filtering, and leaving the precedent list has to clear it whether or not
    // anything was typed. Reading `pristine` for provenance meant that opening
    // precedent on a machine value and pressing Escape verified it.
    const typedRef = useRef(false);
    // The precedent list swaps the input out and back, and each swap refocuses.
    // Neither focus is the annotator ARRIVING at the cell, so neither may
    // forget what they had already typed.
    const reentryRef = useRef(false);
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
      typedRef.current = true;
    };

    // A cell with no controlled list of its own (LEMMA) is a plain input, and
    // showing precedent turns it into a combobox. React unmounts the input to
    // do that, which fires a blur: one that must not be read as "the annotator
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

      const changed = newValue !== (value || '');
      // Re-typing a machine prediction's value is a human confirmation
      // (provenance write contract): commit it even though the value is the
      // same, so the span gets verified. `pristine` guards this to actual
      // typing: tabbing through a cell must not confirm anything.
      const retyped = !changed && typedRef.current && !!mark && !!newValue;
      typedRef.current = false;
      reentryRef.current = false;

      // A CLOSED vocabulary refuses a value that is not on its list. The
      // saved value is kept, not the typed one: an annotator who meant a tag
      // the project does not have wants to see what is actually stored, and a
      // maintainer can open the list up in two clicks. Enforced here and in the
      // Grew rewrite, and nowhere else: an import, a service, the assistant
      // and the API all still get through, which is what the Validation tab is
      // for.
      //
      // Only a value the annotator is actually committing. Refusing before
      // asking whether anything changed meant that a parsed document with any
      // off-list value in it warned once per cell as you tabbed across the
      // sentence, about a value nobody had touched.
      if (changed || retyped) {
        const refusal = validate?.(newValue);
        if (refusal) {
          notifyWarning(refusal, 'Not in the list');
          setValue(value || '');
          return;
        }
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
      if (e.key === 'Tab' && tabTooSoon()) {
        e.preventDefault();
        return;
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

    // Leaving precedent mode swaps the combobox back to a plain input whenever
    // the cell has no list of its own, which LEMMA never does. React fires no
    // blur when it unmounts a focused element, so the cell was left with
    // `isEditing` true and nothing focused: the typed character sat
    // uncommitted and the value-sync effect stayed skipped until the cell was
    // re-entered. `isEditing` is false here when the annotator really left,
    // so this only fires on the swap.
    const hadPrecedent = useRef(false);
    useEffect(() => {
      if (hadPrecedent.current && !precedent && isEditingRef.current) {
        const el = inputRef.current;
        if (el) {
          el.focus();
          // Coming back from the list is not ARRIVING at the cell, so the
          // select-all that focus asks for has to be called off: the text is
          // what the annotator has already typed, and selecting it means the
          // next character replaces it ("wolf" arrived as "olf").
          selectPendingRef.current = false;
          reentryRef.current = true;
          const end = el.value.length;
          el.setSelectionRange?.(end, end);
          // `handleFocus` runs on that focus and resets `pristine`, which is
          // what tells a blur whether the annotator TYPED. Re-entering a
          // machine's own value is a confirmation, and with pristine back to
          // true the commit was skipped: opening precedent on a machine-made
          // lemma, re-typing the same value and tabbing out wrote nothing.
          setPristine(false);
        }
      }
      hadPrecedent.current = !!precedent;
    }, [precedent]);

    const handleFocus = () => {
      // The new element has focus, so the swap is over: from here a blur is the
      // annotator leaving and must commit. Clearing this on the BLUR instead
      // would never happen: React fires none when it unmounts a focused
      // element, and the next real blur would be swallowed silently.
      const arriving = !swappingRef.current && !reentryRef.current;
      swappingRef.current = false;
      reentryRef.current = false;
      setIsEditing(true);
      setPristine(true);
      if (arriving) typedRef.current = false;
      selectOnArrival();
    };

    const displayValue =
      localValue || (field === 'lemma' && !value && !isReadOnly ? tokenForm : '');
    // What the cell shows when nobody has typed in it. The review gestures
    // compare the live input against this to tell an untouched cell from an
    // edited one, and an empty lemma shows the token's form rather than an
    // empty box: comparing against the SAVED value instead meant Ctrl/Cmd
    // +Backspace was never claimed from a lemma cell that had no lemma yet.
    const restingValue = value || (field === 'lemma' && !isReadOnly ? tokenForm : '');
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
      const filterItems = (items, q) => items.filter((o) => textIncludes(o.label, q));
      const optionsFilter = ({ options, search }) => {
        if (precedent || pristine) return options;
        const q = search.toLowerCase().trim();
        return options
          .map((o) => ('group' in o ? { ...o, items: filterItems(o.items, q) } : o))
          .filter((o) => ('group' in o ? o.items.length > 0 : textIncludes(o.label, q)));
      };
      // Commit the picked tag and leave, from a click or from Enter. The value
      // goes through the ref-backed setter so the blur this triggers reads the
      // tag and not the prefix that was typed to find it.
      const takeOption = (picked) => {
        setValue(picked);
        // Choosing the value that is already stored is a verification, the same
        // as re-typing it. The dependency tree's picker has always read a pick
        // that way, and the two disagreed: picking a machine UPOS wrote
        // nothing while picking a machine deprel confirmed it.
        typedRef.current = true;
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
          data-orig={restingValue}
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
            typedRef.current = true;
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
              if (tabTooSoon()) e.preventDefault();
              return;
            }
            if (e.key === 'Enter') {
              // Ctrl/Cmd+Enter is the per-token accept gesture, handled by the
              // one onKeyDown above the whole sentence list (useReviewGestures):
              // let it bubble and keep focus here. preventDefault claims the key
              // from the combobox, which would otherwise commit whatever option
              // is highlighted, and the gesture does not read defaultPrevented,
              // so it still runs. What WOULD stop it is stopPropagation: the
              // gesture only ever sees this event on its way up.
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                return;
              }
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
        data-orig={restingValue}
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
