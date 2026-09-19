import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Combobox } from '@ui/components/shared/combobox';
import { textIncludes } from '@ui/domain/collation.js';

// A small editor floating over the canvas at a point of the graph: a
// Combobox seeded with options, a free value allowed unless `strict`.
//
// Enter commits the highlighted option, else what was typed. A click on an
// option commits it. Blur commits too, since the editor is the one thing
// with focus and leaving it is leaving the edit. Escape cancels. A `done`
// ref keeps the blur that follows an explicit Enter or Escape from firing a
// second time.
//
// `check` says why a value cannot be taken, or nothing when it can. Enter or
// Tab on a refused value leaves the editor open with the reason under it, so
// what was typed is there to correct. A blur still commits, and the caller
// refuses it.
export function InlineEditor({
  x,
  y,
  width = 220,
  value: initial = '',
  options = [],
  placeholder,
  strict = false,
  renderOption,
  onCommit,
  onCancel,
  onDelete,
  onTyped,
  check,
  className = '',
}) {
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState(null);
  const [pristine, setPristine] = useState(true);
  // Whether the arrows have picked an option. A hovered option is highlighted
  // too, and the list opens wherever the pointer happens to rest (under the
  // word an edge was just dropped on), so Enter on an untouched editor trusts
  // the highlight only once the keyboard has moved it.
  const navigatedRef = useRef(false);
  const doneRef = useRef(false);
  const once = (fn) => {
    if (doneRef.current) return;
    doneRef.current = true;
    fn();
  };
  // What is committed, and the option it came from when one was chosen, so
  // a caller can act on what the option carries rather than on its text.
  const commit = (v, option = null) => {
    const text = String(v ?? '').trim();
    if (!text) {
      onCancel();
      return;
    }
    if (strict && !flatValues(options).includes(text)) {
      onCancel();
      return;
    }
    onCommit(text, option);
  };
  // Whether `check` refuses the value, saying why when it does.
  const refuse = (v) => {
    const text = String(v ?? '').trim();
    const why = text && check ? check(text) : null;
    setProblem(why || null);
    return !!why;
  };
  const filter = ({ options: all, search }) => {
    const q = String(search || '').trim();
    if (pristine || !q) return all;
    const keep = (item) => textIncludes(item.value, q) || textIncludes(item.label || '', q);
    return all
      .map((o) => ('group' in o ? { ...o, items: o.items.filter(keep) } : keep(o) ? o : null))
      .filter((o) => o && (!('group' in o) || o.items.length));
  };

  return (
    <div
      className={`umr-inline-editor ${className}`}
      style={{ left: `${x}px`, top: `${y}px`, width: `${width}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* What Shift+Backspace does, for a mouse: the only way to delete a
          re-entrant edge or a document-level relation, neither of which the
          node's own menu can name. The pointer-down is swallowed so the
          input never blurs, because a blur COMMITS. */}
      {onDelete && (
        <button
          type="button"
          className="umr-inline-delete"
          title="Delete"
          aria-label="Delete"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            once(onDelete);
          }}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      )}
      <Combobox
        options={options}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        renderOption={renderOption}
        onChange={(v) => {
          setValue(v);
          setPristine(false);
          setProblem(null);
          onTyped?.(v);
        }}
        onFocus={(e) => {
          setPristine(true);
          setTimeout(() => e.target.select?.(), 0);
        }}
        onBlur={() => once(() => commit(value))}
        onSubmit={(v, option) => once(() => commit(v, option))}
        onKeyDown={(e, combo) => {
          // The canvas listens for keys too: none of these are its.
          e.stopPropagation();
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            navigatedRef.current = true;
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const trusted = !pristine || navigatedRef.current;
            const picked = trusted ? combo.activeValue : null;
            if (refuse(picked != null ? picked : value)) return;
            once(() =>
              commit(picked != null ? picked : value, picked != null ? combo.activeOption : null),
            );
          } else if (e.key === 'Escape') {
            e.preventDefault();
            once(onCancel);
          } else if (e.key === 'Backspace' && e.shiftKey && pristine && onDelete) {
            // While the label is as it opened: once typed in, Shift is a
            // shifted character's, not a chord's.
            e.preventDefault();
            once(onDelete);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            const trusted = !pristine || navigatedRef.current;
            const v = (trusted ? combo.activeValue : null) ?? value;
            if (refuse(v)) return;
            once(() => commit(v));
          }
        }}
        filter={filter}
        autoHighlight={!pristine}
        autoFocus
        className="umr-inline-input"
        optionClassName="px-2 py-0.5 text-xs"
      />
      {problem && (
        <p className="umr-inline-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

const flatValues = (options) =>
  options.flatMap((o) =>
    o && typeof o === 'object' && 'group' in o
      ? o.items.map((i) => (typeof i === 'string' ? i : i.value))
      : [typeof o === 'string' ? o : o.value],
  );
