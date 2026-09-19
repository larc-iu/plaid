import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { needsReview, provState, PROV_STATES } from '@larc-iu/plaid-client';
import { resolveColor, baseRel } from '../../../utils/udVocab.js';
import { provCellTitle, provMark, PROV_MARK_COLORS } from '../../../utils/provenanceUi.js';
import { DeprelEditor } from './DeprelEditor.jsx';
import { useEditorSession } from './editorSession.js';
import { ARC_BASE, LOWER_BAND_TOP, arcHeight, arcPath } from '../../../utils/arcLayout.js';
import { positionMatchesSpanId } from './treePositions.js';
import './DependencyTree.css';

// The enhanced graph's extra edges, hung BELOW the words: the tree is drawn
// above them and what the graph has beside the tree is drawn under them, which
// is where the interfaces people know put it. Position is the whole of the
// mark, so an arc here is drawn exactly as one above is, dash for unreviewed
// and all, and the two never share a space to tangle in.
//
// It draws, renames and deletes. It does not DRAW NEW edges: that is
// Ctrl/Cmd+drag in the tree above, whose grab areas and drag state already
// exist, and the edge lands here. So none of the tree's drag logic is repeated,
// and a sentence with no extra edge has no band at all (see computeLowerBand).
//
// Keyboard: the labels are one row, walked with the arrows or Tab like the
// tree's. Down drops into the grid at the dependent's column. Ctrl/Cmd+D, which
// enters the tree's labels from the grid, goes back up to them from here.
export const EnhancedArcs = forwardRef(
  ({ relations, tokenPositions, layout, top, minWidth, onExitDown, onExitUp }, ref) => {
    const { onRelationUpdate, onRelationDelete, colors } = useEditorSession();
    const deprelColors = colors?.deprel;
    // All three handlers are null on a document that cannot be written.
    const isReadOnly = !onRelationUpdate;

    const [editingId, setEditingId] = useState(null);
    const [focusedId, setFocusedId] = useState(null);
    const [hoveredId, setHoveredId] = useState(null);
    const labelRefs = useRef(new Map());

    const positionOf = (spanId) => tokenPositions.find((p) => positionMatchesSpanId(p, spanId));
    const isRoot = (relation) => relation.source === relation.target;
    const labelXOf = (relation) => {
      const head = positionOf(relation.source);
      if (isRoot(relation)) return head?.x || 0;
      return ((head?.x || 0) + (positionOf(relation.target)?.x || 0)) / 2;
    };
    const sorted = [...relations].sort((a, b) => labelXOf(a) - labelXOf(b));

    const select = (id) => {
      setFocusedId(id);
      labelRefs.current.get(id)?.focus();
    };
    const selectAdjacent = (id, delta) => {
      const i = sorted.findIndex((r) => r.id === id);
      if (i < 0) return;
      select(sorted[(i + delta + sorted.length) % sorted.length].id);
    };

    useImperativeHandle(ref, () => ({
      // From the tree above: Ctrl/Cmd+D on one of its labels comes down here.
      focusFirst: () => {
        if (sorted.length === 0) return false;
        select(sorted[0].id);
        return true;
      },
      // Ctrl/Cmd+drag over a pair that already has an extra edge opens it.
      edit: (id) => {
        if (isReadOnly) return;
        setFocusedId(id);
        setEditingId(id);
      },
    }));

    // When an edit ends the editor unmounts and focus would fall to <body>.
    // Return it to the label, so the arrows go on working (as the tree does).
    useEffect(() => {
      if (!editingId && focusedId) labelRefs.current.get(focusedId)?.focus();
    }, [editingId, focusedId]);

    // The write contract the tree's labels follow: a changed label commits, and
    // an unchanged one commits only when it was deliberately re-entered over a
    // relation still awaiting review, which confirms it.
    const commitLabel = (relation, v, typed) => {
      const t = (v || '').trim();
      if (!t) return;
      const changed = t !== (relation.value || 'dep');
      if (changed || (typed && needsReview(relation.metadata))) onRelationUpdate(relation.id, t);
    };

    const baseline = LOWER_BAND_TOP;

    const renderArc = (relation) => {
      const head = positionOf(relation.source);
      const dependent = positionOf(relation.target);
      if (!head || !dependent) return null;

      const root = isRoot(relation);
      const height = root ? ARC_BASE : arcHeight(layout.levels.get(relation.id) || 1);
      // Leave the head a few pixels along, so the drop does not sit under an
      // arrowhead pointing up at that same word.
      const offset = dependent.x > head.x ? 5 : -5;
      const d = root
        ? `M ${head.x} ${baseline} l 0 ${height}`
        : arcPath(head.x + offset, dependent.x, baseline, -height);

      const mark = provMark(relation.metadata);
      const active =
        editingId === relation.id || hoveredId === relation.id || focusedId === relation.id;
      const color = active
        ? '#2563eb'
        : mark
          ? PROV_MARK_COLORS[mark]
          : resolveColor(baseRel(relation.value || 'dep'), deprelColors);

      const labelX = labelXOf(relation);
      const labelY = baseline + height + 11;
      const arrowX = dependent.x;
      const open = () => {
        if (isReadOnly) return;
        setFocusedId(relation.id);
        setEditingId(relation.id);
      };

      const body = (
        <>
          <path
            d={d}
            stroke={color}
            strokeWidth={active ? 2 : 1}
            strokeDasharray={mark ? '5,4' : undefined}
            className="tree-arc-path enhanced-arc-path"
            onMouseEnter={() => setHoveredId(relation.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={open}
          />
          {/* The arrowhead points UP, into the word. */}
          <polygon
            points={`${arrowX - 3},${baseline} ${arrowX + 3},${baseline} ${arrowX},${baseline - 5}`}
            fill={color}
            className="tree-arc-arrow"
            onClick={open}
          />
        </>
      );

      const label =
        editingId === relation.id ? (
          <foreignObject
            x={labelX - 50}
            y={labelY - 14}
            width="100"
            height="26"
            style={{ overflow: 'visible' }}
          >
            <DeprelEditor
              relation={relation}
              onCommit={(v, typed) => {
                commitLabel(relation, v, typed);
                setEditingId(null);
                setFocusedId(relation.id);
              }}
              onCancel={() => {
                setEditingId(null);
                setFocusedId(relation.id);
              }}
              onDelete={() => {
                // The next arc along takes the focus, rather than the page
                // body, where no key reaches this band.
                const i = sorted.findIndex((r) => r.id === relation.id);
                const next = sorted[i + 1] || sorted[i - 1] || null;
                onRelationDelete(relation.id);
                setEditingId(null);
                setFocusedId(next?.id || null);
              }}
              onTab={(v, shiftKey, typed) => {
                commitLabel(relation, v, typed);
                const i = sorted.findIndex((r) => r.id === relation.id);
                const next = sorted[(i + (shiftKey ? -1 : 1) + sorted.length) % sorted.length];
                setEditingId(next?.id || null);
                setFocusedId(next?.id || null);
              }}
            />
          </foreignObject>
        ) : (
          <text
            x={labelX}
            y={labelY}
            fill={color}
            className={`tree-deprel-text ${focusedId === relation.id ? 'tree-deprel-text--focused' : ''}${mark ? ' tree-deprel-text--marked' : ''}`}
            tabIndex="-1"
            onMouseEnter={() => setHoveredId(relation.id)}
            onMouseLeave={() => setHoveredId(null)}
            onFocus={() => setFocusedId(relation.id)}
            onBlur={() => {
              if (!editingId) setFocusedId(null);
            }}
            onKeyDown={(e) => {
              if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
                // Back up to the tree. Kept from the document, where every
                // sentence's tree listens for this chord as its way IN.
                e.preventDefault();
                e.nativeEvent.stopPropagation();
                onExitUp?.(dependent.token?.id);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                open();
              } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
                e.preventDefault();
                selectAdjacent(relation.id, 1);
              } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault();
                selectAdjacent(relation.id, -1);
              } else if (e.key === 'ArrowDown') {
                if (dependent.token?.id && onExitDown) {
                  e.preventDefault();
                  onExitDown(dependent.token.id);
                }
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setFocusedId(null);
                e.currentTarget.blur();
              }
            }}
            onClick={open}
            ref={(el) => {
              if (el) labelRefs.current.set(relation.id, el);
              else labelRefs.current.delete(relation.id);
            }}
          >
            {relation.value || 'dep'}
            {provState(relation.metadata) !== PROV_STATES.HUMAN && (
              <title>{provCellTitle('deprel', relation.metadata)}</title>
            )}
          </text>
        );

      return { key: relation.id, body, label };
    };

    // Bodies first and labels after, as above: SVG paints in document order,
    // and no arc should be drawn over a label.
    const arcs = tokenPositions.length > 0 ? relations.map(renderArc).filter(Boolean) : [];

    return (
      <svg
        className="enhanced-arcs"
        width="100%"
        height={layout.bandHeight}
        style={{ top: `${top}px`, minWidth: `${minWidth}px` }}
      >
        {arcs.map((a) => (
          <g key={a.key}>{a.body}</g>
        ))}
        {arcs.map((a) => (
          <g key={`${a.key}-label`}>{a.label}</g>
        ))}
      </svg>
    );
  },
);

EnhancedArcs.displayName = 'EnhancedArcs';
