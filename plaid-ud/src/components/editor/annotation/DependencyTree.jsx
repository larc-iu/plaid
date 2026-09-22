import { useState, useRef, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import { resolveColor, baseRel } from '../../../utils/udVocab.js';
import { provMark } from '../../../utils/provenanceUi.js';
import { ArcLabel } from './ArcLabel.jsx';
import {
  afterDeleting,
  arcColor,
  commitsLabel,
  labelChanged,
  stepThrough,
  trimLabel,
} from './arcLabelRules.js';
import { useEditorSession } from './editorSession.js';
import {
  ROOT_BAR_HEIGHT,
  ROOT_GRAB,
  ROOT_Y,
  TREE_OVERHANG,
  arcHeight,
  bandBaselineUnder,
  dragPreview,
  grabRect,
  sortByLabelX,
  svgWidth,
  treeArc,
  treeFrame,
  wordInColumn,
} from '../../../utils/arcLayout.js';
import { suppressedBasicIds } from '../../../domain/enhancedGraph.js';
import { getEffectiveSpanId, positionMatchesSpanId } from './treePositions.js';
import './DependencyTree.css';

// The modifier that turns a tree gesture into an enhanced-graph one. Cmd as
// well as Ctrl, by the app's convention, and here by necessity too: Ctrl+click
// on a Mac is a right click. For an arc it is read ONCE, when the drag (or the
// first of two clicks) begins, and that decides both where the arc in the hand
// is drawn and which graph it is written to. Read at the drop as well, the two
// could disagree, and an arc that changes sides mid-drag is a bug to look at.
const isEnhancedGesture = (event) => Boolean(event?.ctrlKey || event?.metaKey);

// The arc in the hand, while it points at nothing: no word means no label,
// and no label means no colour of its own.
const DRAG_GREY = '#6b7280';

export const DependencyTree = forwardRef(
  (
    {
      tokens,
      relations,
      // The enhanced layer's rows for this sentence, extras and suppressors
      // alike (see domain/enhancedGraph.js). Empty in a project without one.
      enhancedRelations,
      // The extras among them, split out by the row, which needs them for the
      // band below and so is where that split is made.
      extras = [],
      tokenPositions = [],
      onExitDown,
      onEditText,
      arcLayout,
      // The band of enhanced edges under the words (EnhancedArcs), which this
      // tree hands over to: open one of its labels, or move the keyboard there.
      onEditExtra,
      onEnterLowerBand,
    },
    ref,
  ) => {
    // The tree renders inside the grid's provider, so what the whole document
    // shares it reads for itself: the relation handlers (all three null on a
    // read-only document, which is what `isReadOnly` below asks) and the DEPREL
    // colours. The deprel editor reads its own vocabulary the same way.
    const {
      onRelationCreate,
      onRelationUpdate,
      onRelationDelete,
      // Both null unless the project has its enhanced relation layer and the
      // document can be written, which is what `canEnhance` below asks.
      onEnhancedRelationCreate,
      onRelationSuppress,
      colors,
    } = useEditorSession();
    const deprelColors = colors?.deprel;

    // Which of the tree's relations the enhanced graph leaves out. The extras
    // are NOT drawn here: they hang below the words (EnhancedArcs), and this
    // tree only needs to know where one already is, so that drawing over it
    // opens it. A suppressor is not drawn either: it shows as a DIMMED arc and
    // label on the basic relation it lies over.
    const suppressedIds = useMemo(
      () => suppressedBasicIds(relations, enhancedRelations),
      [relations, enhancedRelations],
    );
    const [selectedSource, setSelectedSource] = useState(null);
    const [hoveredToken, setHoveredToken] = useState(null);
    const [editingRelation, setEditingRelation] = useState(null);
    const [hoveredRelation, setHoveredRelation] = useState(null);
    const [focusedRelation, setFocusedRelation] = useState(null);
    const [dragOrigin, setDragOrigin] = useState(null);
    const [dragCurrent, setDragCurrent] = useState(null);
    const [dragSourceId, setDragSourceId] = useState(null);
    // Whether the arc in the hand belongs to the enhanced graph: the modifier
    // as the drag BEGAN, fixed for the whole of it (see isEnhancedGesture).
    const [dragEnhanced, setDragEnhanced] = useState(false);
    // A basic relation whose label editor is open to RELABEL it in the enhanced
    // graph. Nothing is written until a different label is committed.
    const [relabeling, setRelabeling] = useState(null);
    // The ONLY two ways the label editor opens or closes. Relabel mode is a
    // property of one opening of the editor, so it is set and cleared with it:
    // were any path to open or close the editor on its own, a relabel
    // abandoned by a click elsewhere would stay armed, and the next plain edit
    // of that label would be written to the enhanced graph instead of the tree.
    const openEditor = (relation, { relabel = false } = {}) => {
      setRelabeling(relabel && relation ? relation.id : null);
      setEditingRelation(relation);
    };
    const closeEditor = () => {
      setRelabeling(null);
      setEditingRelation(null);
    };
    const [positionsInitialized, setPositionsInitialized] = useState(false);
    const svgRef = useRef(null);
    // True from the mousedown that starts a drag until something ends it, so a
    // release is acted on once however many listeners hear it.
    const dragLiveRef = useRef(false);
    const labelRefs = useRef(new Map());

    // The tree is only as tall as its deepest stack of arcs needs (see
    // arcLayout). The sentence grid reserves the matching padding, so the two
    // read the same layout and cannot drift apart.
    const TREE_HEIGHT = arcLayout.treeHeight;
    // Where the words and the line every arc springs from fall inside a tree
    // that tall. Everything geometric below is asked of arcLayout with this.
    const frame = treeFrame(TREE_HEIGHT);
    const TOKEN_Y = frame.tokenY;

    // How high above the words this relation's arc runs. An arc encloses
    // everything nested under it, one step per level.
    const heightOf = (relation) => arcHeight(arcLayout.levels.get(relation.id) || 1);

    // When re-pointing a token's head (it already has an incoming arc), keep its
    // existing deprel instead of resetting to 'dep'. A root self-loop is excluded
    // (a non-root head shouldn't inherit 'root').
    const incomingDeprel = (targetPosition) => {
      const prev = relations.find(
        (rel) => positionMatchesSpanId(targetPosition, rel.target) && rel.source !== rel.target,
      );
      return prev?.value || 'dep';
    };

    // The measured word positions, with one y for all of them: every arc
    // leaves and lands on the same baseline whatever a word's own box does.
    // Empty until the grid has been measured, which is one frame away: the
    // evenly spaced positions this used to invent in the meantime put nothing
    // on screen (the arcs wait for `positionsInitialized`) but a row of
    // invisible grab rects in places no word was.
    const adjustedTokenPositions = tokenPositions.map((pos) => ({ ...pos, y: TOKEN_Y }));

    // Editing is disabled (read-only) whenever the parent withholds the relation
    // handlers — i.e. for viewer access or while viewing a past state. Guard every
    // interaction entry point so drawing/label-editing can't start (and so calling
    // a null handler can never throw).
    const isReadOnly = !onRelationCreate;
    const canEnhance = !isReadOnly && Boolean(onEnhancedRelationCreate);

    // Draw an edge of the enhanced graph from one word to another (the same
    // word twice for a root). Over a pair the tree already joins, that is a
    // relabel, so the basic relation's label opens to take the new one. Over a
    // pair that already has an extra edge, that edge's label opens, as drawing
    // over an existing basic relation does.
    const drawEnhanced = (sourcePosition, targetPosition, sourceId, targetId) => {
      const over = (rel) =>
        positionMatchesSpanId(sourcePosition, rel.source) &&
        positionMatchesSpanId(targetPosition, rel.target);
      const existingExtra = extras.find(over);
      if (existingExtra) {
        onEditExtra?.(existingExtra.id);
        return;
      }
      const basic = relations.find(over);
      if (basic) {
        openEditor(basic, { relabel: true });
        return;
      }
      const isRoot = sourceId === targetId;
      onEnhancedRelationCreate(
        sourceId,
        targetId,
        isRoot ? 'root' : incomingDeprel(targetPosition),
      );
    };

    // Handle mouse down on token (start drag)
    const handleTokenMouseDown = (e, position) => {
      e.preventDefault();
      if (isReadOnly) return;
      if (editingRelation) {
        closeEditor();
        return;
      }

      dragLiveRef.current = true;
      setDragOrigin({ x: position.x, y: position.y });
      setDragCurrent({ x: position.x, y: position.y });
      setDragSourceId(getEffectiveSpanId(position));
      setDragEnhanced(canEnhance && isEnhancedGesture(e));
    };

    const endDrag = () => {
      dragLiveRef.current = false;
      setDragOrigin(null);
      setDragCurrent(null);
      setDragSourceId(null);
    };

    // The arc in the hand lands on a word (or, from the ROOT bar, makes it a
    // root). Which graph takes it was settled when the drag began.
    const completeDrop = (position) => {
      if (isReadOnly || !dragOrigin || !dragSourceId) return;
      const sourceId = dragSourceId;
      const targetId = getEffectiveSpanId(position);
      const sourcePosition = adjustedTokenPositions.find((p) => positionMatchesSpanId(p, sourceId));
      const targetPosition = position;

      if (dragEnhanced && targetId && (sourceId === 'ROOT' || sourceId !== targetId)) {
        if (sourceId === 'ROOT') drawEnhanced(targetPosition, targetPosition, targetId, targetId);
        else drawEnhanced(sourcePosition, targetPosition, sourceId, targetId);
      }
      // Handle drag FROM ROOT to token
      else if (sourceId === 'ROOT' && targetId) {
        // Look for existing ROOT relation (self-pointing relation)
        const existingRelation = relations.find(
          (rel) =>
            positionMatchesSpanId(targetPosition, rel.source) &&
            positionMatchesSpanId(targetPosition, rel.target),
        );

        if (existingRelation) {
          openEditor(existingRelation);
        } else {
          onRelationCreate(targetId, targetId, 'root'); // Self-pointing relation
        }
      }
      // Handle drag FROM token to token
      else if (sourceId !== targetId && sourceId !== 'ROOT' && targetId) {
        const existingRelation = relations.find(
          (rel) =>
            positionMatchesSpanId(sourcePosition, rel.source) &&
            positionMatchesSpanId(targetPosition, rel.target),
        );

        if (existingRelation) {
          openEditor(existingRelation);
        } else {
          if (sourceId && targetId) {
            onRelationCreate(sourceId, targetId, incomingDeprel(targetPosition));
          }
        }
      }
    };

    // Handle mouse up on token (complete drag)
    const handleTokenMouseUp = (e, position) => {
      e.stopPropagation();
      if (isReadOnly) return;
      // The word the arc in the hand is SHOWN landing on, which where two
      // short words' reach overlaps is the nearer and not always the one whose
      // grab box is on top.
      let shown = null;
      if (dragOrigin && svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        shown = wordUnder({ x: e.clientX - rect.left, y: e.clientY - rect.top }, dragEnhanced);
      }
      completeDrop(shown || position);
      endDrag();
    };

    // Handle mouse down on ROOT (start drag from ROOT)
    const handleRootMouseDown = (e) => {
      e.preventDefault();
      if (isReadOnly) return;
      if (editingRelation) {
        closeEditor();
        return;
      }

      // Get the exact click position on the ROOT bar
      const rect = svgRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      dragLiveRef.current = true;
      setDragOrigin({ x: clickX, y: clickY });
      setDragCurrent({ x: clickX, y: clickY });
      setDragSourceId('ROOT');
      setDragEnhanced(canEnhance && isEnhancedGesture(e));
    };

    // Handle mouse up on ROOT (when dragging TO ROOT)
    const handleRootMouseUp = (e) => {
      e.stopPropagation();
      if (isReadOnly) return;
      if (dragOrigin && dragSourceId && dragSourceId !== 'ROOT') {
        const sourceId = dragSourceId;
        const sourcePosition = adjustedTokenPositions.find((p) =>
          positionMatchesSpanId(p, sourceId),
        );

        // Look for existing ROOT relation (self-pointing relation)
        const existingRelation = relations.find(
          (rel) =>
            positionMatchesSpanId(sourcePosition, rel.source) &&
            positionMatchesSpanId(sourcePosition, rel.target),
        );

        if (dragEnhanced) {
          drawEnhanced(sourcePosition, sourcePosition, sourceId, sourceId);
        } else if (existingRelation) {
          openEditor(existingRelation);
        } else {
          onRelationCreate(sourceId, sourceId, 'root'); // Self-pointing relation
        }
      }

      endDrag();
    };

    // The word an arc in the hand would land on, out of the words on screen.
    // The reach and the two bands (above the words for the tree, below them
    // for the enhanced graph) are arcLayout's.
    const wordUnder = (point, below) =>
      wordInColumn(adjustedTokenPositions, point, { below, frame });

    // While an arc is in the hand the WINDOW is listened to, not this SVG: the
    // SVG ends at the words, and a pointer followed only inside it leaves an
    // enhanced arc frozen the moment the hand goes where that arc is drawn.
    // The handlers are read off a ref so the listeners, bound once per drag,
    // always run this render's.
    const dragHandlersRef = useRef(null);
    dragHandlersRef.current = {
      move: (e) => {
        if (!svgRef.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        setDragCurrent({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      },
      // A release that no word or ROOT bar took (those stop it reaching here).
      up: (e) => {
        if (!dragLiveRef.current) return;
        if (svgRef.current) {
          const rect = svgRef.current.getBoundingClientRect();
          const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          const word = wordUnder(point, dragEnhanced);
          if (word) completeDrop(word);
          // Above the ROOT bar is the bar: the arc in the hand is already
          // drawn as a root there (see the preview's own rule), and letting
          // go used to write nothing at all.
          else if (!dragEnhanced && point.y < ROOT_GRAB) handleRootMouseUp(e);
        }
        endDrag();
      },
    };
    const dragging = Boolean(dragOrigin);
    useEffect(() => {
      if (!dragging) return undefined;
      const move = (e) => dragHandlersRef.current.move(e);
      const up = (e) => dragHandlersRef.current.up(e);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
    }, [dragging]);

    // Handle token click for relation creation (fallback to click-click)
    const handleTokenClick = (event, position) => {
      // Alt+click hands over to the Text Editor at this sentence, the mirror of
      // Alt+click on a token there. It lives on the tree's grab area rather
      // than on the word's form below it, because this transparent rect is
      // drawn over that form and is what a click on a word actually hits.
      // Allowed while read-only: reading the text of a sentence is not an edit.
      if (event?.altKey && onEditText) {
        event.preventDefault();
        event.stopPropagation();
        onEditText();
        return;
      }
      if (isReadOnly) return;
      if (editingRelation) {
        closeEditor();
        return;
      }

      const spanId = getEffectiveSpanId(position);

      if (!selectedSource) {
        setSelectedSource({
          ...position,
          spanId,
          enhanced: canEnhance && isEnhancedGesture(event),
        });
      } else if (
        selectedSource.spanId === spanId ||
        selectedSource.token?.id === position.token?.id
      ) {
        setSelectedSource(null);
      } else {
        const sourceId = selectedSource.spanId;
        const targetId = spanId;
        const sourcePosition = adjustedTokenPositions.find((p) =>
          positionMatchesSpanId(p, sourceId),
        );
        const targetPosition =
          adjustedTokenPositions.find((p) => positionMatchesSpanId(p, targetId)) || position;

        const existingRelation = relations.find(
          (rel) =>
            positionMatchesSpanId(sourcePosition, rel.source) &&
            positionMatchesSpanId(targetPosition, rel.target),
        );

        if (selectedSource.enhanced && sourceId && targetId) {
          drawEnhanced(sourcePosition, targetPosition, sourceId, targetId);
        } else if (existingRelation) {
          openEditor(existingRelation);
        } else {
          if (sourceId && targetId) {
            onRelationCreate(sourceId, targetId, incomingDeprel(targetPosition));
          }
        }

        setSelectedSource(null);
      }
    };

    // Handle ROOT click
    const handleRootClick = () => {
      if (isReadOnly) return;
      if (selectedSource && selectedSource.spanId !== 'ROOT') {
        const sourceId = selectedSource.spanId;
        const sourcePosition =
          adjustedTokenPositions.find((p) => positionMatchesSpanId(p, sourceId)) || selectedSource;

        // Look for existing ROOT relation (self-pointing relation)
        const existingRelation = relations.find(
          (rel) =>
            positionMatchesSpanId(sourcePosition, rel.source) &&
            positionMatchesSpanId(sourcePosition, rel.target),
        );

        if (selectedSource.enhanced) {
          drawEnhanced(sourcePosition, sourcePosition, sourceId, sourceId);
        } else if (existingRelation) {
          openEditor(existingRelation);
        } else {
          onRelationCreate(sourceId, sourceId, 'root'); // Self-pointing relation
        }

        setSelectedSource(null);
      }
    };

    // The labels in the order the keyboard walks them: left to right across
    // the sentence, a root over its own word. The band below walks its own by
    // the same rule.
    const xOfSpan = (spanId) =>
      adjustedTokenPositions.find((p) => positionMatchesSpanId(p, spanId))?.x;
    const sortedRelations = sortByLabelX(relations, xOfSpan);

    // Global keydown: only the Ctrl+D entry point (jump into the dependency
    // labels) and Escape (bail out of any in-progress interaction) live here.
    // Per-label navigation (arrows / Tab / Enter) is handled element-scoped on the
    // focused <text> below, so it doesn't fight this listener or fire once per
    // mounted sentence.
    // Whose sentence the key belongs to: every mounted tree listens on the
    // document, so without this the last one to bind won the chord and
    // Ctrl+D from a cell of sentence 1 jumped into sentence 25.
    const inThisSentence = (e) => {
      const row = svgRef.current?.closest('[data-sentence-row]');
      if (!row) return true;
      const where = e.target instanceof Node && e.target !== document ? e.target : null;
      return row.contains(where) || row.contains(document.activeElement);
    };
    const handleKeyDown = (e) => {
      if (!inThisSentence(e)) return;
      if (e.key === 'd' && (e.ctrlKey || e.metaKey) && !focusedRelation && !editingRelation) {
        e.preventDefault();
        focusFirstRelation();
        return;
      }
      // The same chord from INSIDE this tree's labels goes on down to the
      // enhanced edges under the words, when the sentence has any.
      if (e.key === 'd' && (e.ctrlKey || e.metaKey) && focusedRelation && !editingRelation) {
        e.preventDefault();
        if (onEnterLowerBand?.()) setFocusedRelation(null);
        return;
      }
      if (e.key === 'Escape') {
        setSelectedSource(null);
        closeEditor();
        setFocusedRelation(null);
        setDragOrigin(null);
        setDragCurrent(null);
        setDragSourceId(null);
      }
    };

    // `handleKeyDown` is redefined every render; the listener is rebound only
    // when something it actually reads has changed, which is what this list is.
    useEffect(() => {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusedRelation, editingRelation, sortedRelations, relations]);

    // Selecting (not editing) a label keeps focus on its <text> so arrows/Tab can
    // move on. When editing ends (Enter/Escape commit), the <foreignObject> editor
    // unmounts and focus would fall to <body>; this returns it to the now-selected
    // label so navigation continues. Editing transitions (editingRelation set)
    // are skipped — the editor autofocuses itself.
    useEffect(() => {
      if (!editingRelation && focusedRelation) {
        labelRefs.current.get(focusedRelation)?.focus();
      }
    }, [editingRelation, focusedRelation]);

    // A relation's dependent is its `target` (source = head), so a token in the
    // grid maps 1:1 to the label of the relation it heads (its own deprel). These
    // power the arrow handoff between the grid and the tree.
    const relationForToken = (tokenId) => {
      const pos = adjustedTokenPositions.find((p) => p.token?.id === tokenId);
      if (!pos) return null;
      return relations.find((rel) => positionMatchesSpanId(pos, rel.target)) || null;
    };
    const tokenIdForRelation = (relation) => {
      const pos = adjustedTokenPositions.find((p) => positionMatchesSpanId(p, relation.target));
      return pos?.token?.id || null;
    };
    const selectRelation = (relationId) => {
      setFocusedRelation(relationId);
      labelRefs.current.get(relationId)?.focus();
    };
    // Move selection to the adjacent label in visual (left-to-right) order.
    const selectAdjacentRelation = (relationId, delta) => {
      const next = stepThrough(sortedRelations, relationId, delta);
      if (next) selectRelation(next.id);
    };

    // Imperative entry from the grid: ArrowUp out of the top annotation row lands
    // on that token's deprel label. Returns true when a label was focused so the
    // caller can preventDefault (else the grid handler dead-ends as before).
    useImperativeHandle(ref, () => ({
      // Selection (not editing) is allowed even in read-only, so viewers can move
      // focus through the labels; opening the editor is what's gated elsewhere.
      focusRelationForToken: (tokenId) => {
        const rel = relationForToken(tokenId);
        if (!rel) return false;
        selectRelation(rel.id);
        return true;
      },
      // Back up from the band under the words, which knows no particular label
      // of this tree to land on when the word it left has no head here.
      focusFirst: () => {
        if (sortedRelations.length === 0) return false;
        selectRelation(sortedRelations[0].id);
        return true;
      },
    }));

    // Track when token positions are initialized
    useEffect(() => {
      if (tokenPositions.length > 0 && tokens.length > 0) {
        // Delay to ensure positions are accurate after DOM measurement
        const timeoutId = setTimeout(() => {
          setPositionsInitialized(true);
        }, 100);
        return () => clearTimeout(timeoutId);
      } else {
        setPositionsInitialized(false);
      }
    }, [tokenPositions, tokens]);

    // Helper function to focus first relation for keyboard navigation
    const focusFirstRelation = () => {
      if (sortedRelations.length > 0 && !focusedRelation) {
        const firstRelation = sortedRelations[0];
        setFocusedRelation(firstRelation.id);
        const labelElement = labelRefs.current.get(firstRelation.id);
        labelElement?.focus();
      }
    };

    // Render dependency arc
    // Commit an edited deprel label, by the write contract in ArcLabel.
    const commitLabel = (relation, v, typed) => {
      const t = trimLabel(v);
      if (!t) return;
      // A relabel writes to the enhanced graph and leaves the tree's label as
      // it was. The same label again is no relabel, so nothing is written.
      if (relabeling === relation.id) {
        if (labelChanged(relation, t))
          onEnhancedRelationCreate(relation.source, relation.target, t);
        return;
      }
      if (commitsLabel(relation, t, typed)) onRelationUpdate(relation.id, t);
    };

    // Whether the enhanced graph has this basic relation. Ctrl/Cmd+click on it,
    // or Ctrl/Cmd+E on its focused label, says it does not, and again that it
    // does.
    const toggleSuppressed = (relation) => {
      if (!canEnhance || !onRelationSuppress) return false;
      onRelationSuppress(relation.id, !suppressedIds.has(relation.id));
      return true;
    };

    // A click on an arc, its arrowhead or its label.
    const handleArcClick = (event, relation) => {
      if (isReadOnly) return;
      if (isEnhancedGesture(event) && toggleSuppressed(relation)) return;
      openEditor(relation);
      setFocusedRelation(relation.id);
    };

    const renderArc = (relation) => {
      // Check if this is a self-pointing relation (ROOT relation)
      const isSelfPointing = relation.source === relation.target;

      const sourcePos = adjustedTokenPositions.find((p) =>
        positionMatchesSpanId(p, relation.source),
      );
      // A root points its word at itself, so it has the one position.
      const targetPos = isSelfPointing
        ? sourcePos
        : adjustedTokenPositions.find((p) => positionMatchesSpanId(p, relation.target));

      if (!sourcePos || !targetPos) {
        return null;
      }

      const isSuppressed = suppressedIds.has(relation.id);
      const isSelected = editingRelation?.id === relation.id;
      const isHovered = hoveredRelation === relation.id;
      const isFocused = focusedRelation === relation.id;
      const isToRoot = isSelfPointing;

      // The path, the arrowhead and where the label goes: one answer, from
      // the same module the band below the words draws itself from.
      const shape = treeArc({
        fromX: sourcePos.x,
        toX: targetPos.x,
        toRoot: isToRoot,
        height: heightOf(relation),
        frame,
      });
      const pathId = `arc-${relation.id}`;

      // Unreviewed relations read as their provenance hue + a dashed stroke:
      // the dash is the unambiguous cue, so it can't be confused with a settled
      // relation whose configured DEPREL color happens to be purple or amber.
      // Approved relations color by the base DEPREL (configured map → deterministic
      // auto); selection/hover/focus keep the highlight blue. `color` drives the
      // arc stroke, arrowhead fill, and resting label fill, so the label matches.
      const inferred = !!provMark(relation.metadata);
      const active = isSelected || isHovered || isFocused;
      const color = arcColor(relation, active, deprelColors);
      const strokeWidth = active ? 2 : 1;
      // A relation the enhanced graph leaves out is faded, arc and label both:
      // what the graph has instead, if anything, hangs under the words. Not
      // italic, which is the unreviewed mark, and not struck out,
      // which reads as deleted when the relation is as much in the tree as
      // ever. At full strength while hovered or focused, so it is no harder to
      // read or to hit than any other.
      const dimmed = isSuppressed && !active;

      // Split into `body` (arc + arrowhead) and `label` so the caller can paint
      // ALL bodies first and ALL labels after — in SVG, later = on top, so every
      // deprel label sits above every arc (no arc overdrawing a label).
      const body = (
        <>
          {/* Arc path */}
          <path
            id={pathId}
            d={shape.d}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={inferred ? '5,4' : undefined}
            opacity={dimmed ? 0.35 : undefined}
            className="tree-arc-path"
            onMouseEnter={() => setHoveredRelation(relation.id)}
            onMouseLeave={() => setHoveredRelation(null)}
            onClick={(e) => handleArcClick(e, relation)}
          />

          {/* Arrow polygon */}
          <polygon
            points={shape.arrow}
            fill={color}
            opacity={dimmed ? 0.35 : undefined}
            className="tree-arc-arrow"
            onClick={(e) => handleArcClick(e, relation)}
          />
        </>
      );

      const label = (
        <ArcLabel
          relation={relation}
          at={shape.label}
          color={color}
          editing={editingRelation?.id === relation.id}
          focused={isFocused}
          // A basic relation the enhanced graph leaves out is faded, arc and
          // label both. `--suppressed` is the state and styles nothing (it is
          // what a test asks about), `--dimmed` is the look.
          className={`${isSuppressed ? ' tree-deprel-text--suppressed' : ''}${dimmed ? ' tree-deprel-text--dimmed' : ''}`}
          // A suppressed relation's hover record is the fact a reader cannot
          // get from the faded label alone.
          title={isSuppressed ? 'Not in the enhanced graph' : undefined}
          onOpen={() => {
            if (!isReadOnly) openEditor(relation);
          }}
          onHover={(on) => setHoveredRelation(on ? relation.id : null)}
          onFocusIn={() => setFocusedRelation(relation.id)}
          onFocusOut={() => {
            // Clear selection only when focus leaves for good (not while the
            // editor is taking over). The editor transitions re-set
            // focusedRelation, so a transient clear here is harmless.
            if (!editingRelation) setFocusedRelation(null);
          }}
          onStep={(delta) => selectAdjacentRelation(relation.id, delta)}
          onExitDown={() => {
            const tid = tokenIdForRelation(relation);
            if (!tid || !onExitDown) return false;
            onExitDown(tid);
            return true;
          }}
          onEscape={() => setFocusedRelation(null)}
          onChord={(e) => {
            if ((e.key !== 'e' && e.key !== 'E') || !isEnhancedGesture(e)) return false;
            // Taken whether or not it applies here, so the browser's own
            // Ctrl/Cmd+E never fires from inside the tree.
            e.preventDefault();
            toggleSuppressed(relation);
            return true;
          }}
          onClick={(e) => handleArcClick(e, relation)}
          onCommit={(v, typed) => {
            commitLabel(relation, v, typed);
            // Stay on this label (selected, not editing) so arrow/Tab nav
            // continues; the refocus effect returns focus to its <text>.
            closeEditor();
            setFocusedRelation(relation.id);
          }}
          onCancel={() => {
            closeEditor();
            setFocusedRelation(relation.id);
          }}
          // Mid-relabel there is nothing of the enhanced graph's to delete
          // yet, and the tree's relation is not what was asked about.
          onDelete={
            relabeling === relation.id
              ? undefined
              : () => {
                  const next = afterDeleting(sortedRelations, relation.id);
                  onRelationDelete(relation.id);
                  closeEditor();
                  setFocusedRelation(next?.id || null);
                }
          }
          onTab={(v, shiftKey, typed) => {
            commitLabel(relation, v, typed);
            const next = stepThrough(sortedRelations, relation.id, shiftKey ? -1 : 1);
            openEditor(next || null);
            setFocusedRelation(next?.id || null);
          }}
          labelRef={labelRefs.current}
        />
      );

      return { key: relation.id, body, label };
    };

    // The arc in the hand. Its SHAPE is arcLayout's (dragPreview), which draws
    // it as the arc it is about to become; what is decided here is what only
    // this component knows: which word the hand is over, which arcs the new
    // one will stack among, and what label it will wear.
    const renderDragArc = () => {
      if (!dragOrigin || !dragCurrent || !dragSourceId) return null;

      const fromRoot = dragSourceId === 'ROOT';
      const sourcePos = fromRoot
        ? null
        : adjustedTokenPositions.find((p) => positionMatchesSpanId(p, dragSourceId));
      if (!fromRoot && !sourcePos) return null;

      const below = dragEnhanced;
      // The word this arc would land on if let go now, and whether the hand is
      // on the ROOT bar instead.
      const over = wordUnder(dragCurrent, below);
      const target = over && (fromRoot || over !== sourcePos) ? over : null;
      const toRoot =
        !fromRoot && (hoveredToken?.lemmaSpanId === 'ROOT' || dragCurrent.y < ROOT_GRAB);

      // The arcs this one will share its side of the words with. A re-pointed
      // head replaces the word's present one, which is not among them.
      const columnOf = (spanId) =>
        adjustedTokenPositions.find((p) => positionMatchesSpanId(p, spanId))?.index;
      const spansOf = (rels) =>
        rels
          .filter((rel) => rel.source !== rel.target)
          .map((rel) => [columnOf(rel.source), columnOf(rel.target)])
          .filter(([a, b]) => a !== undefined && b !== undefined)
          .map(([a, b], i) => ({ id: i, left: Math.min(a, b), right: Math.max(a, b) }));
      const spans = target
        ? spansOf(
            below ? extras : relations.filter((rel) => !positionMatchesSpanId(target, rel.target)),
          )
        : [];

      const shape = dragPreview({
        from: sourcePos,
        to: target,
        pointer: dragCurrent,
        below,
        toRoot,
        spans,
        frame,
        // The band hangs off the measured underside of a word, which the one
        // y every arc springs from has been flattened out of.
        under: (word) =>
          bandBaselineUnder(
            tokenPositions.find((p) => p.token?.id === word?.token?.id),
            TREE_HEIGHT,
          ),
      });

      // A label comes back exactly when the arc has a word at each end, so it
      // has a label to wear and a colour of its own.
      const text = shape.label ? (fromRoot || toRoot ? 'root' : incomingDeprel(target)) : null;

      return (
        <g
          className={below ? 'tree-drag-arc tree-drag-arc--enhanced' : 'tree-drag-arc'}
          style={{ color: text ? resolveColor(baseRel(text), deprelColors) : DRAG_GREY }}
        >
          <path d={shape.d} />
          {shape.arrow && <polygon points={shape.arrow} />}
          {shape.label && (
            <text x={shape.label.x} y={shape.label.y} className="tree-drag-label">
              {text}
            </text>
          )}
        </g>
      );
    };

    // As wide as the last word plus room for its arc — the same width the
    // band of enhanced edges under the words takes.
    const minSvgWidth = svgWidth(adjustedTokenPositions);

    return (
      <div className="dependency-tree-container" style={{ top: `${-TREE_OVERHANG}px` }}>
        <svg
          ref={svgRef}
          width="100%"
          height={TREE_HEIGHT}
          className="tree-svg"
          style={{ minWidth: `${minSvgWidth}px` }}
        >
          {/* ROOT bar - positioned above the arcs */}
          <rect
            x={0}
            y={ROOT_Y}
            width="100%"
            height={ROOT_BAR_HEIGHT}
            fill={hoveredToken?.lemmaSpanId === 'ROOT' ? '#e5e7eb' : '#fafafa'}
            className={selectedSource || dragOrigin ? 'tree-root-rect' : 'tree-root-rect--default'}
            onClick={() => handleRootClick()}
            onMouseDown={handleRootMouseDown}
            onMouseUp={handleRootMouseUp}
            onMouseEnter={() => setHoveredToken({ lemmaSpanId: 'ROOT' })}
            onMouseLeave={() => setHoveredToken(null)}
          />

          {/* Render existing relations - only when positions are initialized.
            Paint all arc bodies first, then all labels, so every deprel label
            sits above every arc (SVG paint order = document order). */}
          {positionsInitialized &&
            (() => {
              const arcs = relations
                .map((relation, index) => renderArc(relation, index))
                .filter(Boolean);
              return (
                <>
                  {arcs.map((a) => (
                    <g key={a.key}>{a.body}</g>
                  ))}
                  {arcs.map((a) => (
                    <g key={`${a.key}-label`}>{a.label}</g>
                  ))}
                </>
              );
            })()}

          {/* Render drag arc - only when positions are initialized */}
          {positionsInitialized && renderDragArc()}

          {/* Invisible token click areas */}
          {adjustedTokenPositions.map((position) => {
            // The same reach a drag snaps by, so a word is clickable exactly
            // where it is droppable.
            const box = grabRect(position);

            return (
              <rect
                key={position.token.id}
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                fill="transparent"
                className={`tree-token-area ${dragOrigin ? 'tree-token-area--drag' : 'tree-token-area--grab'}`}
                onClick={(e) => handleTokenClick(e, position)}
                onMouseDown={(e) => handleTokenMouseDown(e, position)}
                onMouseUp={(e) => handleTokenMouseUp(e, position)}
                onMouseEnter={() => setHoveredToken(position)}
                onMouseLeave={() => setHoveredToken(null)}
              />
            );
          })}
        </svg>
      </div>
    );
  },
);

DependencyTree.displayName = 'DependencyTree';
