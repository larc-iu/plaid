import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ATTRIBUTES } from '../../../domain/format/inventory.js';
import { latticeFor, linesFor, valuesFor } from '../../../domain/lattices.js';
import { attrsToLine, lineToAttrs } from './pickers.js';

// The attributes with a value set, in the order the picker lists them.
const PICKED = [
  ':aspect',
  ':modal-strength',
  ':polarity',
  ':mode',
  ':refer-person',
  ':refer-number',
  ':refer-definiteness',
  ':degree',
  ':polite',
].filter((rel) => ATTRIBUTES[rel]);

// The attribute picker, floating under a node. One row per attribute with a
// value set: a lattice from coarse to fine where the guidelines draw one
// (aspect, person, number), a list otherwise. Every pick writes at once and
// the picker stays open, so a node's attributes are set in one visit. What
// has no set (`:quant`, `:wiki`, `:op1`) is a text line at the bottom.
//
// Keys: arrows move between values and lines, Enter or Space picks the
// focused one, Backspace clears the focused row, Escape closes. Focus leaving
// the picker closes it too.
export function AttributePopover({ x, y, width = 440, attrs, sets, onChange, onClose }) {
  const rootRef = useRef(null);
  const byRel = useMemo(() => new Map(attrs.map((a) => [a.rel, a])), [attrs]);
  const rows = useMemo(
    () =>
      PICKED.map((rel) => {
        const values = valuesFor(rel, sets);
        const lattice = latticeFor(rel, values);
        const current = byRel.get(rel)?.value ?? null;
        const lines = lattice
          ? linesFor(lattice, current)
          : [{ values, on: values.includes(current) ? current : null }];
        return { rel, current, lines };
      }),
    [byRel, sets],
  );
  // The attributes outside the rows, as one editable line.
  const others = useMemo(() => attrs.filter((a) => !PICKED.includes(a.rel)), [attrs]);
  const [otherLine, setOtherLine] = useState(() => attrsToLine(others));
  useEffect(() => setOtherLine(attrsToLine(others)), [others]);

  // A value replaces the attribute's, keeping the others in their order.
  const set = (rel, value) => {
    const kept = attrs.filter((a) => a.rel !== rel);
    onChange(value == null ? kept : [...kept, { rel, value }]);
  };
  const commitOthers = () => {
    const line = otherLine.trim();
    const next = lineToAttrs(line);
    if (attrsToLine(next) === attrsToLine(others)) return;
    onChange([...attrs.filter((a) => PICKED.includes(a.rel)), ...next]);
  };

  // Focus lands on the first row's chosen value, or its first value.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const first = root.querySelector('[aria-pressed="true"]') || root.querySelector('button');
    first?.focus();
  }, []);

  // Roving focus over the value buttons, by the line they sit on.
  const move = (from, dLine, dCol) => {
    const root = rootRef.current;
    const lines = [...root.querySelectorAll('[data-line]')];
    const lineIndex = lines.findIndex((l) => l.contains(from));
    if (lineIndex < 0) return;
    const buttons = (line) => [...line.querySelectorAll('button')];
    const col = buttons(lines[lineIndex]).indexOf(from);
    const target = lines[Math.max(0, Math.min(lines.length - 1, lineIndex + dLine))];
    const row = buttons(target);
    const next = row[Math.max(0, Math.min(row.length - 1, dLine ? col : col + dCol))];
    next?.focus();
  };

  const onKeyDown = (e) => {
    // The canvas listens for keys too: none of these are its.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.target.tagName === 'INPUT') return;
    const arrows = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (arrows[e.key]) {
      e.preventDefault();
      move(e.target, ...arrows[e.key]);
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      const rel = e.target.closest('[data-rel]')?.dataset.rel;
      if (rel && byRel.has(rel)) {
        e.preventDefault();
        set(rel, null);
      }
    }
  };

  return (
    <div
      ref={rootRef}
      className="umr-inline-editor umr-attr-popover"
      style={{ left: `${x}px`, top: `${y}px`, width: `${width}px` }}
      role="dialog"
      aria-label="Attributes"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      {rows.map((row) => (
        <div key={row.rel} className="umr-attr-row" data-rel={row.rel}>
          <div className="umr-attr-label">
            <span>{row.rel.slice(1)}</span>
            {row.current != null && (
              <button
                type="button"
                className="umr-attr-clear"
                tabIndex={-1}
                aria-label={`Clear ${row.rel.slice(1)}`}
                onClick={() => set(row.rel, null)}
              >
                <X size={11} />
              </button>
            )}
          </div>
          <div className="umr-attr-lines">
            {row.lines.map((line, i) => (
              <div key={i} className="umr-attr-line" data-line>
                {line.values.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="umr-attr-value"
                    aria-pressed={value === row.current}
                    data-on-path={value === line.on && value !== row.current ? '' : undefined}
                    onClick={() => set(row.rel, value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="umr-attr-row">
        <div className="umr-attr-label">
          <span>other</span>
        </div>
        <input
          className="umr-attr-other"
          value={otherLine}
          placeholder=':quant 3 :wiki "Q42"'
          spellCheck={false}
          onChange={(e) => setOtherLine(e.target.value)}
          onBlur={commitOthers}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitOthers();
            }
          }}
        />
      </div>
      <div className="umr-attr-hint">
        Arrows move, Enter picks, Backspace clears the row, Escape closes.
      </div>
    </div>
  );
}
