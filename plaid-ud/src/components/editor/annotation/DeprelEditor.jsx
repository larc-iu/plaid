import { useState, useRef } from 'react';
import { Autocomplete } from '@mantine/core';
import { readFieldProbs, groupSuggestions, probLabel } from '../../../utils/provenanceUi.js';

// Inline editor for a dependency-relation label, rendered inside the tree's
// SVG <foreignObject>. Mirrors the grid's vocab cells: a Mantine Autocomplete
// seeded with the configured DEPREL vocabulary — clicking shows the full list,
// the first keystroke filters, and off-list values are still accepted (soft).
// When the producing parser recorded a deprel distribution
// (metadata.provDetail.deprelProbs), its top-k floats above the rest as a
// "Parser suggestions" group with dimmed probability suffixes.
//
// Keyboard contract (preserved from the old contentEditable editor):
//   Enter / blur     → commit + close
//   Escape           → cancel + close
//   Shift+Delete     → delete the relation
//   Tab / Shift+Tab  → commit + move to the next/previous relation
// A `done` ref guards against the blur firing a second commit after an
// explicit Enter/Tab/Escape/Delete already closed the editor.
export function DeprelEditor({ relation, suggestions, onCommit, onCancel, onDelete, onTab }) {
  const [value, setValue] = useState(relation.value || 'dep');
  const [pristine, setPristine] = useState(true);
  const doneRef = useRef(false);

  const once = (fn) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };

  const deprelProbs = readFieldProbs(relation.metadata, 'deprel');

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
      data={groupSuggestions(suggestions || [], deprelProbs)}
      renderOption={deprelProbs ? ({ option }) => {
        const pct = probLabel(deprelProbs, option.value);
        return (
          <span>
            {option.value}
            {pct && <span style={{ opacity: 0.55, marginLeft: 6, fontSize: '0.85em' }}>{pct}</span>}
          </span>
        );
      } : undefined}
      value={value}
      onChange={(v) => { setValue(v); setPristine(false); }}
      onFocus={(e) => { setPristine(true); setTimeout(() => e.target.select?.(), 0); }}
      onBlur={() => once(() => onCommit(value))}
      // Arrow-key navigation only HIGHLIGHTS an option; it doesn't update
      // `value`. Mantine applies the highlighted option via onOptionSubmit (on
      // Enter or click) — commit *that* value. The Enter branch below handles
      // free text (no highlighted option, so onOptionSubmit never fires); it's
      // deferred to a microtask so that when an option IS highlighted,
      // onOptionSubmit (which runs synchronously right after our keydown) wins
      // and `once` blocks the stale typed-value commit.
      onOptionSubmit={(v) => once(() => onCommit(v))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); queueMicrotask(() => once(() => onCommit(value))); }
        else if (e.key === 'Escape') { e.preventDefault(); once(onCancel); }
        else if (e.key === 'Delete' && e.shiftKey) { e.preventDefault(); once(onDelete); }
        else if (e.key === 'Tab') { e.preventDefault(); once(() => onTab(value, e.shiftKey)); }
      }}
      filter={optionsFilter}
      selectFirstOptionOnChange={false}
      autoFocus
      size="xs"
      maxDropdownHeight={240}
      comboboxProps={{ withinPortal: true, width: 'max-content', position: 'bottom-start' }}
      styles={{
        input: {
          height: 22, minHeight: 22, padding: '0 6px', fontSize: 11,
          textAlign: 'center', fontFamily: 'sans-serif',
          borderColor: '#2563eb', color: '#2563eb'
        },
        option: { whiteSpace: 'nowrap', fontSize: 11 }
      }}
    />
  );
}
