import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { provMark } from '../../../utils/provenanceUi.js';
import { ArcLabel } from './ArcLabel.jsx';
import { afterDeleting, arcColor, commitsLabel, stepThrough, trimLabel } from './arcLabelRules.js';
import { useEditorSession } from './editorSession.js';
import { ARC_BASE, arcHeight, bandArc, sortByLabelX } from '../../../utils/arcLayout.js';
import { positionMatchesSpanId } from './treePositions.js';
import './DependencyTree.css';

// The enhanced graph's extra edges, hung BELOW the words: the tree is drawn
// above them and what the graph has beside the tree is drawn under them, which
// is where the interfaces people know put it. Position is the whole of the
// mark, so an arc here is drawn exactly as one above is, dash for unreviewed
// and all, and the two never share a space to tangle in. The shape of one is
// `bandArc` and its label is `ArcLabel`, the same two the tree draws through.
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
    // Left to right across the sentence, as the tree walks its own labels.
    const sorted = sortByLabelX(relations, (spanId) => positionOf(spanId)?.x);

    const select = (id) => {
      setFocusedId(id);
      labelRefs.current.get(id)?.focus();
    };
    const selectAdjacent = (id, delta) => {
      const next = stepThrough(sorted, id, delta);
      if (next) select(next.id);
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

    const commitLabel = (relation, v, typed) => {
      const t = trimLabel(v);
      if (t && commitsLabel(relation, t, typed)) onRelationUpdate(relation.id, t);
    };

    const renderArc = (relation) => {
      const head = positionOf(relation.source);
      const dependent = positionOf(relation.target);
      if (!head || !dependent) return null;

      const root = isRoot(relation);
      const shape = bandArc({
        fromX: head.x,
        toX: dependent.x,
        toRoot: root,
        height: root ? ARC_BASE : arcHeight(layout.levels.get(relation.id) || 1),
      });

      const mark = provMark(relation.metadata);
      const active =
        editingId === relation.id || hoveredId === relation.id || focusedId === relation.id;
      const color = arcColor(relation, active, deprelColors);

      const open = () => {
        if (isReadOnly) return;
        setFocusedId(relation.id);
        setEditingId(relation.id);
      };

      const body = (
        <>
          <path
            d={shape.d}
            stroke={color}
            strokeWidth={active ? 2 : 1}
            strokeDasharray={mark ? '5,4' : undefined}
            className="tree-arc-path enhanced-arc-path"
            onMouseEnter={() => setHoveredId(relation.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={open}
          />
          {/* The arrowhead points UP, into the word. */}
          <polygon points={shape.arrow} fill={color} className="tree-arc-arrow" onClick={open} />
        </>
      );

      const label = (
        <ArcLabel
          relation={relation}
          at={shape.label}
          color={color}
          editing={editingId === relation.id}
          focused={focusedId === relation.id}
          onOpen={open}
          onHover={(on) => setHoveredId(on ? relation.id : null)}
          onFocusIn={() => setFocusedId(relation.id)}
          onFocusOut={() => {
            if (!editingId) setFocusedId(null);
          }}
          onStep={(delta) => selectAdjacent(relation.id, delta)}
          onExitDown={() => {
            if (!dependent.token?.id || !onExitDown) return false;
            onExitDown(dependent.token.id);
            return true;
          }}
          onEscape={() => setFocusedId(null)}
          onChord={(e) => {
            if ((e.key !== 'd' && e.key !== 'D') || !(e.ctrlKey || e.metaKey)) return false;
            // Back up to the tree. Kept from the document, where every
            // sentence's tree listens for this chord as its way IN.
            e.preventDefault();
            e.nativeEvent.stopPropagation();
            onExitUp?.(dependent.token?.id);
            return true;
          }}
          onClick={open}
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
            const next = afterDeleting(sorted, relation.id);
            onRelationDelete(relation.id);
            setEditingId(null);
            setFocusedId(next?.id || null);
          }}
          onTab={(v, shiftKey, typed) => {
            commitLabel(relation, v, typed);
            const next = stepThrough(sorted, relation.id, shiftKey ? -1 : 1);
            setEditingId(next?.id || null);
            setFocusedId(next?.id || null);
          }}
          labelRef={labelRefs.current}
        />
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
