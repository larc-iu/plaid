import { provState, PROV_STATES } from '@larc-iu/plaid-client';
import { provCellTitle, provMark } from '../../../utils/provenanceUi.js';
import { DeprelEditor } from './DeprelEditor.jsx';
import {
  LABEL_EDITOR_HEIGHT,
  LABEL_EDITOR_LIFT,
  LABEL_EDITOR_WIDTH,
} from '../../../utils/arcLayout.js';

// The deprel label on an arc. UD draws arcs in two places — the tree above the
// words (DependencyTree) and the band of enhanced edges below them
// (EnhancedArcs) — and a label is a label in both: the same walk with the
// arrows and Tab, the same inline editor opened by Enter or a click, the same
// handover down into the grid, the same colour and hover record
// (arcLabelRules.js).
//
// Written twice, they drifted: the editor sat 12px above the label in the tree
// and 14 in the band, and the Tab wrap was a modulo in one and a nested
// ternary in the other. What genuinely differs between the two is one chord
// (Ctrl/Cmd+E suppresses in the tree, Ctrl/Cmd+D leaves the band upwards),
// which comes in as `onChord` and gets first refusal on every key.

/**
 * One arc's label.
 *
 *   at         where it sits, `{ x, y }` from arcLayout
 *   editing    the inline editor is open on it
 *   focused    it is the keyboard's label (selected, not being edited)
 *   className  what only one of the two callers says about it
 *   title      a hover record to show INSTEAD of the provenance one
 *   onChord    first refusal on every key; true means it took it
 *   onExitDown truthy when the keyboard went down into the grid
 *   onDelete   withheld where there is nothing to delete, and the editor's
 *              bin goes with it
 *   labelRef   the caller's Map of id to element, for moving focus about
 */
export const ArcLabel = ({
  relation,
  at,
  color,
  editing = false,
  focused = false,
  className = '',
  title,
  onOpen,
  onHover,
  onFocusIn,
  onFocusOut,
  onStep,
  onExitDown,
  onEscape,
  onChord,
  onClick,
  onCommit,
  onCancel,
  onDelete,
  onTab,
  labelRef,
}) => {
  if (editing) {
    return (
      <foreignObject
        x={at.x - LABEL_EDITOR_WIDTH / 2}
        y={at.y - LABEL_EDITOR_LIFT}
        width={LABEL_EDITOR_WIDTH}
        height={LABEL_EDITOR_HEIGHT}
        style={{ overflow: 'visible' }}
      >
        <DeprelEditor
          relation={relation}
          onCommit={onCommit}
          onCancel={onCancel}
          onDelete={onDelete}
          onTab={onTab}
        />
      </foreignObject>
    );
  }

  const mark = provMark(relation?.metadata);
  const hoverRecord =
    title !== undefined
      ? title
      : provState(relation?.metadata) !== PROV_STATES.HUMAN
        ? provCellTitle('deprel', relation?.metadata)
        : null;

  return (
    <text
      x={at.x}
      y={at.y}
      fill={color}
      className={`tree-deprel-text ${focused ? 'tree-deprel-text--focused' : ''}${mark ? ' tree-deprel-text--marked' : ''}${className}`}
      tabIndex="-1"
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      // Focusing SELECTS the label (highlight + keyboard target); it does not
      // open the editor — Enter or a click does. That is what lets the arrows
      // move between labels and focus return here after a commit.
      onFocus={() => onFocusIn?.()}
      onBlur={() => onFocusOut?.()}
      onKeyDown={(e) => {
        if (onChord?.(e)) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen?.();
        } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
          e.preventDefault();
          onStep?.(1);
        } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
          e.preventDefault();
          onStep?.(-1);
        } else if (e.key === 'ArrowDown') {
          // Down drops into the grid at this label's dependent column. The
          // caller says whether there was anywhere to land.
          if (onExitDown?.()) e.preventDefault();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onEscape?.();
          e.currentTarget.blur();
        }
      }}
      onClick={onClick}
      ref={(el) => {
        if (el) labelRef?.set(relation.id, el);
        else labelRef?.delete(relation.id);
      }}
    >
      {relation.value || 'dep'}
      {/* One hover record to a label, as an SVG-native tooltip. */}
      {hoverRecord && <title>{hoverRecord}</title>}
    </text>
  );
};
