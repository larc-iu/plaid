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
// Matching/selection (once you start typing):
//   - matches are ordered by closeness to what's typed: exact first, then
//     left-to-right prefix matches, then later substring matches;
//   - the best (first) match is auto-highlighted, so Enter confirms it;
//   - when what's typed isn't a known tag, it's offered verbatim as the LAST
//     item ("Use … as typed") — pick it by click to annotate literally (rare).
//
// Keyboard contract (preserved from the old contentEditable editor):
//   Enter / blur     → commit + close (Enter commits the highlighted match)
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

  // "Use literally what's typed" escape hatch: when the typed value isn't a
  // known tag, offer it verbatim. It's appended LAST and never auto-selected,
  // so Enter still confirms the best real match while a deliberate click
  // annotates the literal value (overrides are rare).
  const typed = (value || '').trim();
  const vocabLower = new Set((suggestions || []).map((s) => s.toLowerCase()));
  const literalValue = typed && !vocabLower.has(typed.toLowerCase()) ? typed : null;
  const data = literalValue
    ? [...groupSuggestions(suggestions || [], deprelProbs), { value: literalValue, label: literalValue }]
    : groupSuggestions(suggestions || [], deprelProbs);

  // Order matches by closeness to the query: exact, then left-to-right prefix,
  // then later substring; ties broken by match position, then length, then name.
  const rankCmp = (a, b, q) => {
    const al = a.toLowerCase(), bl = b.toLowerCase();
    const rank = (l) => (l === q ? 0 : l.startsWith(q) ? 1 : 2);
    const ra = rank(al), rb = rank(bl);
    if (ra !== rb) return ra - rb;
    const ia = al.indexOf(q), ib = bl.indexOf(q);
    if (ia !== ib) return ia - ib;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  };
  const filterSort = (items, q) =>
    !q ? items : items.filter((o) => o.label.toLowerCase().includes(q)).sort((a, b) => rankCmp(a.label, b.label, q));

  // Group-aware filter: the data may be flat or grouped. Keeps the literal item
  // (if present) out of filtering and pins it last; everything else is
  // match-ranked once the user has started typing.
  const optionsFilter = ({ options, search }) => {
    const literal = literalValue ? options.find((o) => !('group' in o) && o.value === literalValue) : null;
    const rest = literal ? options.filter((o) => o !== literal) : options;
    let body;
    if (pristine) {
      body = rest; // just opened: show the full list in its natural order
    } else {
      const q = search.toLowerCase().trim();
      const groups = rest
        .filter((o) => 'group' in o)
        .map((o) => ({ ...o, items: filterSort(o.items, q) }))
        .filter((o) => o.items.length > 0);
      const plain = filterSort(rest.filter((o) => !('group' in o)), q);
      body = [...groups, ...plain];
    }
    return literal ? [...body, literal] : body;
  };

  return (
    <Autocomplete
      data={data}
      renderOption={({ option }) => {
        if (literalValue && option.value === literalValue) {
          return <span style={{ fontStyle: 'italic', opacity: 0.8 }}>Use “{option.value}” as typed</span>;
        }
        const pct = deprelProbs ? probLabel(deprelProbs, option.value) : null;
        return (
          <span>
            {option.value}
            {pct && <span style={{ opacity: 0.55, marginLeft: 6, fontSize: '0.85em' }}>{pct}</span>}
          </span>
        );
      }}
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
      // Auto-highlight the best match for Enter — but only once typing has
      // started. While pristine (just opened, showing the full list) nothing is
      // pre-selected, so Enter keeps the current value.
      selectFirstOptionOnChange={!pristine}
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
