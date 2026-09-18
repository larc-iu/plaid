import { useRef, useState } from 'react';
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
  onTyped,
  className = '',
}) {
  const [value, setValue] = useState(initial);
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
  const commit = (v) => {
    const text = String(v ?? '').trim();
    if (!text) {
      onCancel();
      return;
    }
    if (strict && !flatValues(options).includes(text)) {
      onCancel();
      return;
    }
    onCommit(text);
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
      <Combobox
        options={options}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        renderOption={renderOption}
        onChange={(v) => {
          setValue(v);
          setPristine(false);
          onTyped?.(v);
        }}
        onFocus={(e) => {
          setPristine(true);
          setTimeout(() => e.target.select?.(), 0);
        }}
        onBlur={() => once(() => commit(value))}
        onSubmit={(v) => once(() => commit(v))}
        onKeyDown={(e, combo) => {
          // The canvas listens for keys too: none of these are its.
          e.stopPropagation();
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            navigatedRef.current = true;
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const trusted = !pristine || navigatedRef.current;
            const picked = trusted ? combo.activeValue : null;
            once(() => commit(picked != null ? picked : value));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            once(onCancel);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            const trusted = !pristine || navigatedRef.current;
            once(() => commit((trusted ? combo.activeValue : null) ?? value));
          }
        }}
        filter={filter}
        autoHighlight={!pristine}
        autoFocus
        className="umr-inline-input"
        optionClassName="px-2 py-0.5 text-xs"
      />
    </div>
  );
}

const flatValues = (options) =>
  options.flatMap((o) =>
    o && typeof o === 'object' && 'group' in o
      ? o.items.map((i) => (typeof i === 'string' ? i : i.value))
      : [typeof o === 'string' ? o : o.value],
  );
