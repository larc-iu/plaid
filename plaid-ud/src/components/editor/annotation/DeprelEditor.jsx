import { useState, useRef } from 'react';
import { Combobox } from '@ui/components/ui/combobox';
import { readFieldProbs, groupSuggestions, probLabel } from '../../../utils/provenanceUi.js';
import { notifyWarning } from '../../../utils/notify.js';

// Inline editor for a dependency-relation label, rendered inside the tree's
// SVG <foreignObject>. Mirrors the grid's vocab cells: a Combobox seeded with
// the configured DEPREL vocabulary — focusing shows the full list, the first
// keystroke filters, and off-list values are still accepted (soft). When the
// producing parser recorded a deprel distribution
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
export function DeprelEditor({
  relation,
  suggestions,
  descriptions,
  validate,
  onCommit,
  onCancel,
  onDelete,
  onTab,
}) {
  const [value, setValue] = useState(relation.value || 'dep');
  const [pristine, setPristine] = useState(true);
  const doneRef = useRef(false);

  const once = (fn) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };

  // A CLOSED deprel list governs the BASE relation: `nsubj:pass` is legal
  // wherever `nsubj` is, because subtypes are language-specific and open-ended
  // and a project that listed every one it used would be re-listing the
  // language. A refusal cancels the edit rather than committing, so the arc
  // keeps the label it had.
  const commitOr = (next, typed) => {
    const refusal = validate?.(next);
    if (refusal) {
      notifyWarning(refusal, 'Not in the list');
      onCancel();
      return;
    }
    onCommit(next, typed);
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
    ? [
        ...groupSuggestions(suggestions || [], deprelProbs),
        { value: literalValue, label: literalValue },
      ]
    : groupSuggestions(suggestions || [], deprelProbs);

  // Order matches by closeness to the query: exact, then left-to-right prefix,
  // then later substring; ties broken by match position, then length, then name.
  const rankCmp = (a, b, q) => {
    const al = a.toLowerCase(),
      bl = b.toLowerCase();
    const rank = (l) => (l === q ? 0 : l.startsWith(q) ? 1 : 2);
    const ra = rank(al),
      rb = rank(bl);
    if (ra !== rb) return ra - rb;
    const ia = al.indexOf(q),
      ib = bl.indexOf(q);
    if (ia !== ib) return ia - ib;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  };
  const filterSort = (items, q) =>
    !q
      ? items
      : items
          .filter((o) => o.label.toLowerCase().includes(q))
          .sort((a, b) => rankCmp(a.label, b.label, q));

  // Group-aware filter: the data may be flat or grouped. Keeps the literal item
  // (if present) out of filtering and pins it last; everything else is
  // match-ranked once the user has started typing.
  const optionsFilter = ({ options, search }) => {
    const literal = literalValue
      ? options.find((o) => !('group' in o) && o.value === literalValue)
      : null;
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
      const plain = filterSort(
        rest.filter((o) => !('group' in o)),
        q,
      );
      body = [...groups, ...plain];
    }
    return literal ? [...body, literal] : body;
  };

  return (
    <Combobox
      options={data}
      spellCheck={false}
      renderOption={({ option }) => {
        if (literalValue && option.value === literalValue) {
          return (
            <span style={{ fontStyle: 'italic', opacity: 0.8 }}>Use “{option.value}” as typed</span>
          );
        }
        const pct = deprelProbs ? probLabel(deprelProbs, option.value) : null;
        const gloss = descriptions?.[option.value];
        return (
          <span>
            {option.value}
            {pct && <span style={{ opacity: 0.55, marginLeft: 6, fontSize: '0.85em' }}>{pct}</span>}
            {gloss && (
              <span style={{ opacity: 0.6, marginLeft: 8, fontSize: '0.85em' }}>{gloss}</span>
            )}
          </span>
        );
      }}
      value={value}
      onChange={(v) => {
        setValue(v);
        setPristine(false);
      }}
      onFocus={(e) => {
        setPristine(true);
        setTimeout(() => e.target.select?.(), 0);
      }}
      // The second argument tells the caller whether the human actually typed /
      // picked (vs. just opened and left): re-entering the machine's own label
      // is a confirmation, but merely passing through the editor is not.
      onBlur={() => once(() => commitOr(value, !pristine))}
      // Clicking an option commits it, and a click is always a deliberate pick.
      onSubmit={(v) => once(() => commitOr(v, true))}
      onKeyDown={(e, combo) => {
        // stopPropagation so the dependency tree's global document keydown
        // listener (Escape = bail, Ctrl+D = enter) doesn't also fire while the
        // editor owns these keys — keeps Enter/Escape returning focus to the
        // selected label instead of clearing it.
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          // Arrow keys highlight an option without touching `value`, so the
          // highlighted one wins when there is one. It is read straight off the
          // list rather than inferred from a later event, which is the whole
          // point of the combobox handing its state to the key handler.
          const picked = combo.activeValue;
          once(() => (picked != null ? commitOr(picked, true) : commitOr(value, !pristine)));
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          once(onCancel);
        } else if (e.key === 'Delete' && e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          once(onDelete);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          once(() => {
            const refusal = validate?.(value);
            if (refusal) {
              notifyWarning(refusal, 'Not in the list');
              onCancel();
              return;
            }
            onTab(value, e.shiftKey, !pristine);
          });
        }
      }}
      filter={optionsFilter}
      // Auto-highlight the best match for Enter — but only once typing has
      // started. While pristine (just opened, showing the full list) nothing is
      // pre-selected, so Enter keeps the current value.
      autoHighlight={!pristine}
      autoFocus
      className="deprel-edit-input"
      optionClassName="px-2 py-0.5 text-[11px]"
    />
  );
}
