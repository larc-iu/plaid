import { useState, useRef, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import { needsReview, provState, PROV_STATES } from '@larc-iu/plaid-client';
import { resolveColor, baseRel } from '../../../utils/udVocab.js';
import { provCellTitle, provMark, PROV_MARK_COLORS } from '../../../utils/provenanceUi.js';
import { DeprelEditor } from './DeprelEditor.jsx';
import { useEditorSession } from './editorSession.js';
import {
  ARC_BASE,
  LOWER_BAND_TOP,
  arcHeight,
  arcPath,
  handArcPath,
  levelAmong,
} from '../../../utils/arcLayout.js';
import { extraEdges, suppressedBasicIds } from '../../../domain/enhancedGraph.js';
import { getEffectiveSpanId, positionMatchesSpanId } from './treePositions.js';
import './DependencyTree.css';

// Machine-made or contributed, not yet human-verified (provenance convention).
// The deprel label renders marked until a human edits or accepts it.
const isInferredRelation = (relation) => needsReview(relation?.metadata);

// Which mark an unreviewed relation wears: violet for a machine's, amber for a
// contributor's, matching the annotation cells. Paired with a dashed stroke so
// the state never relies on colour alone (a configured DEPREL colour could
// itself be purple: see the dash below).
const relationMark = (relation) => provMark(relation?.metadata);

// The modifier that turns a tree gesture into an enhanced-graph one. Cmd as
// well as Ctrl, by the app's convention, and here by necessity too: Ctrl+click
// on a Mac is a right click. For an arc it is read ONCE, when the drag (or the
// first of two clicks) begins, and that decides both where the arc in the hand
// is drawn and which graph it is written to. Read at the drop as well, the two
// could disagree, and an arc that changes sides mid-drag is a bug to look at.
const isEnhancedGesture = (event) => Boolean(event?.ctrlKey || event?.metaKey);

export const DependencyTree = forwardRef(
  (
    {
      tokens,
      relations,
      // The enhanced layer's rows for this sentence, extras and suppressors
      // alike (see domain/enhancedGraph.js). Empty in a project without one.
      enhancedRelations,
      lemmaSpans,
      textContent,
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

    // What the enhanced graph has beside the tree, and which of the tree's
    // relations it leaves out. The extras are NOT drawn here: they hang below
    // the words (EnhancedArcs), and this tree only needs to know where one
    // already is, so that drawing over it opens it. A suppressor is not drawn
    // either: it shows as a DIMMED arc and label on the basic relation it
    // lies over.
    const extras = useMemo(() => extraEdges(enhancedRelations), [enhancedRelations]);
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

    // Constants for layout (back to original working version)
    const TOKEN_SPACING = 80;
    // The tree is only as tall as its deepest stack of arcs needs (see
    // arcLayout). The sentence grid reserves the matching padding, so the two
    // read the same layout and cannot drift apart.
    const TREE_HEIGHT = arcLayout.treeHeight;
    const PADDING = 20;
    const TOKEN_Y = TREE_HEIGHT - 30; // Tokens at bottom
    const ROOT_Y = 25; // ROOT bar at top

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

    // Use passed token positions for X coordinates, but keep original Y logic
    const adjustedTokenPositions =
      tokenPositions.length > 0
        ? tokenPositions.map((pos) => ({
            ...pos,
            y: TOKEN_Y, // Use original TOKEN_Y for consistent arc drawing
          }))
        : tokens.map((token, index) => {
            // `textContent` is the provider object from SentenceRow (a `.substring`
            // that resolves a token's form by exact begin/end), NOT a raw string —
            // don't slice it. This fallback runs on the first render after tokens
            // appear (e.g. just after a parse) before token positions are measured.
            const tokenForm = textContent.substring(token.begin, token.end);
            const matchingLemmaSpan = lemmaSpans.find(
              (span) => (span.tokens && span.tokens.includes(token.id)) || span.begin === token.id,
            );

            return {
              token,
              x: PADDING + index * TOKEN_SPACING + TOKEN_SPACING / 2,
              y: TOKEN_Y,
              form: tokenForm,
              lemmaSpanId: matchingLemmaSpan?.id,
              index: index,
            };
          });

    // Generate SVG path for dependency arc
    const computeEdge = (sourcePos, targetPos, isToRoot, height) => {
      const y = TOKEN_Y - 10;

      // A root relation drops straight from the ROOT bar onto its token.
      if (isToRoot) {
        return `M ${sourcePos.x} ${y} l 0 ${ROOT_Y + 10 - y}`;
      }

      // The arc leaves the head a few pixels along, so that its rise doesn't sit
      // on top of an arrowhead pointing at that same word.
      const offset = targetPos.x > sourcePos.x ? 5 : -5;
      return arcPath(sourcePos.x + offset, targetPos.x, y, height);
    };

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
      completeDrop(position);
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

    // The word an ENHANCED arc in the hand is over when the pointer is at or
    // under the row of words: its column, however far down. That arc is drawn
    // under the words, so under them is where the hand goes, and the tree's
    // own grab areas stop at the words. A plain arc lands on a grab area, as
    // it always has.
    const wordUnder = (point) => {
      if (!point || point.y < TOKEN_Y - 12) return null;
      return (
        adjustedTokenPositions.find(
          (p) => Math.abs(point.x - p.x) <= Math.max((p.width || 60) * 0.6, 24),
        ) || null
      );
    };

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
        if (dragEnhanced && svgRef.current) {
          const rect = svgRef.current.getBoundingClientRect();
          const word = wordUnder({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          if (word) completeDrop(word);
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

    // Sort relations by label X position for logical tab order
    const sortedRelations = [...relations].sort((a, b) => {
      // Calculate label positions for both relations
      const getLabelX = (relation) => {
        const isSelfPointing = relation.source === relation.target;
        const sourcePos = adjustedTokenPositions.find((p) =>
          positionMatchesSpanId(p, relation.source),
        );

        if (isSelfPointing) {
          // ROOT relation - label is centered above the source token
          return sourcePos?.x || 0;
        } else {
          // Regular relation - label is at midpoint between source and target
          const targetPos = adjustedTokenPositions.find((p) =>
            positionMatchesSpanId(p, relation.target),
          );
          return ((sourcePos?.x || 0) + (targetPos?.x || 0)) / 2;
        }
      };

      return getLabelX(a) - getLabelX(b);
    });

    // Global keydown: only the Ctrl+D entry point (jump into the dependency
    // labels) and Escape (bail out of any in-progress interaction) live here.
    // Per-label navigation (arrows / Tab / Enter) is handled element-scoped on the
    // focused <text> below, so it doesn't fight this listener or fire once per
    // mounted sentence.
    const handleKeyDown = (e) => {
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
      if (sortedRelations.length === 0) return;
      const idx = sortedRelations.findIndex((r) => r.id === relationId);
      if (idx < 0) return;
      const next = sortedRelations[(idx + delta + sortedRelations.length) % sortedRelations.length];
      selectRelation(next.id);
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
    // Commit an edited deprel label. A changed label always commits; an
    // UNCHANGED label commits only when the human actually typed/picked it
    // (`typed`) and the relation is a machine prediction — re-entering the
    // machine's own label is a confirmation (provenance write contract), while
    // merely opening the editor and leaving is not.
    const commitLabel = (relation, v, typed) => {
      const t = (v || '').trim();
      if (!t) return;
      const changed = t !== (relation.value || 'dep');
      // A relabel writes to the enhanced graph and leaves the tree's label as
      // it was. The same label again is no relabel, so nothing is written.
      if (relabeling === relation.id) {
        if (changed) onEnhancedRelationCreate(relation.source, relation.target, t);
        return;
      }
      if (changed || (typed && isInferredRelation(relation))) onRelationUpdate(relation.id, t);
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
      const targetPos = isSelfPointing
        ? { x: sourcePos?.x || 0, y: ROOT_Y, index: -1 }
        : adjustedTokenPositions.find((p) => positionMatchesSpanId(p, relation.target));

      if (!sourcePos || (!targetPos && !isSelfPointing)) {
        return null;
      }

      const isSuppressed = suppressedIds.has(relation.id);
      const isSelected = editingRelation?.id === relation.id;
      const isHovered = hoveredRelation === relation.id;
      const isFocused = focusedRelation === relation.id;
      const isToRoot = isSelfPointing;

      const height = heightOf(relation);
      const pathData = computeEdge(sourcePos, targetPos, isToRoot, height);
      const pathId = `arc-${relation.id}`;

      // Calculate arrow position - for ROOT relations, arrow points to the token
      const arrowX = isToRoot ? sourcePos.x : targetPos.x;
      const arrowY = isToRoot ? TOKEN_Y - 10 : TOKEN_Y - 10;

      // The label rides just above its arc's horizontal run.
      let labelX, labelY;
      if (isToRoot) {
        labelX = sourcePos.x;
        labelY = (TOKEN_Y + ROOT_Y) / 2;
      } else {
        labelX = (sourcePos.x + targetPos.x) / 2;
        labelY = TOKEN_Y - 10 - height - 5;
      }

      // Unreviewed relations read as their provenance hue + a dashed stroke:
      // the dash is the unambiguous cue, so it can't be confused with a settled
      // relation whose configured DEPREL color happens to be purple or amber.
      // Approved relations color by the base DEPREL (configured map → deterministic
      // auto); selection/hover/focus keep the highlight blue. `color` drives the
      // arc stroke, arrowhead fill, and resting label fill, so the label matches.
      const mark = relationMark(relation);
      const inferred = !!mark;
      const active = isSelected || isHovered || isFocused;
      const restColor = mark
        ? PROV_MARK_COLORS[mark]
        : resolveColor(baseRel(relation.value || 'dep'), deprelColors);
      const color = active ? '#2563eb' : restColor;
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
            d={pathData}
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
            points={`${arrowX - 3},${arrowY - 3} ${arrowX + 3},${arrowY - 3} ${arrowX},${arrowY + 2}`}
            fill={color}
            opacity={dimmed ? 0.35 : undefined}
            className="tree-arc-arrow"
            onClick={(e) => handleArcClick(e, relation)}
          />
        </>
      );

      const label = (
        <>
          {/* DEPREL label */}
          {editingRelation?.id === relation.id ? (
            <foreignObject
              x={labelX - 50}
              y={labelY - 12}
              width="100"
              height="26"
              style={{ overflow: 'visible' }}
            >
              <DeprelEditor
                relation={relation}
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
                // Mid-relabel there is nothing of the enhanced graph's to
                // delete yet, and the tree's relation is not what was asked
                // about. Withheld, the editor offers no bin and reads the
                // chord as a cancel.
                onDelete={
                  relabeling === relation.id
                    ? undefined
                    : () => {
                        onRelationDelete(relation.id);
                        closeEditor();
                        setFocusedRelation(null);
                      }
                }
                onTab={(v, shiftKey, typed) => {
                  commitLabel(relation, v, typed);
                  const idx = sortedRelations.findIndex((r) => r.id === relation.id);
                  const nextIdx = shiftKey
                    ? idx > 0
                      ? idx - 1
                      : sortedRelations.length - 1
                    : idx < sortedRelations.length - 1
                      ? idx + 1
                      : 0;
                  const next = sortedRelations[nextIdx];
                  openEditor(next || null);
                  setFocusedRelation(next?.id || null);
                }}
              />
            </foreignObject>
          ) : (
            <text
              x={labelX}
              y={labelY}
              fill={color}
              className={`tree-deprel-text ${isFocused ? 'tree-deprel-text--focused' : ''}${mark ? ' tree-deprel-text--marked' : ''}${isSuppressed ? ' tree-deprel-text--suppressed' : ''}${dimmed ? ' tree-deprel-text--dimmed' : ''}`}
              tabIndex="-1"
              onMouseEnter={() => setHoveredRelation(relation.id)}
              onMouseLeave={() => setHoveredRelation(null)}
              onFocus={() => {
                // Focusing SELECTS the label (highlight + keyboard target); it no
                // longer opens the editor — Enter/click does. This is what lets
                // arrows move between labels and focus return here after Enter.
                setFocusedRelation(relation.id);
              }}
              onBlur={() => {
                // Clear selection only when focus leaves for good (not while the
                // editor is taking over). The editor transitions re-set
                // focusedRelation, so a transient clear here is harmless.
                if (!editingRelation) {
                  setFocusedRelation(null);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (!isReadOnly) {
                    openEditor(relation);
                  }
                } else if ((e.key === 'e' || e.key === 'E') && isEnhancedGesture(e)) {
                  // Taken whether or not it applies here, so the browser's own
                  // Ctrl/Cmd+E never fires from inside the tree.
                  e.preventDefault();
                  toggleSuppressed(relation);
                } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
                  e.preventDefault();
                  selectAdjacentRelation(relation.id, 1);
                } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
                  e.preventDefault();
                  selectAdjacentRelation(relation.id, -1);
                } else if (e.key === 'ArrowDown') {
                  // Drop into the grid: this label's dependent token column.
                  const tid = tokenIdForRelation(relation);
                  if (tid && onExitDown) {
                    e.preventDefault();
                    onExitDown(tid);
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setFocusedRelation(null);
                  e.currentTarget.blur();
                }
              }}
              onClick={(e) => handleArcClick(e, relation)}
              ref={(el) => {
                if (el) {
                  labelRefs.current.set(relation.id, el);
                } else {
                  labelRefs.current.delete(relation.id);
                }
              }}
            >
              {relation.value || 'dep'}
              {/* Hover record for machine-made relations (SVG-native tooltip).
                  One <title> to a label, and a suppressed relation's is the
                  fact a reader cannot get from the faded label alone. */}
              {isSuppressed ? (
                <title>Not in the enhanced graph</title>
              ) : (
                provState(relation.metadata) !== PROV_STATES.HUMAN && (
                  <title>{provCellTitle('deprel', relation.metadata)}</title>
                )
              )}
            </text>
          )}
        </>
      );

      return { key: relation.id, body, label };
    };

    // Render drag arrow during mouse drag
    // The arc in the hand, drawn as close to the arc it will become as can be
    // known, and on ONE side of the words for the whole drag: above for the
    // tree, below for the enhanced graph, as the drag began. Over a word it IS
    // the arc to come: at the level the stacking will give it, in the colour
    // of the label it will take, with that label and an arrowhead. Between
    // words it is the same shape ending at the pointer.
    const renderDragArc = () => {
      if (!dragOrigin || !dragCurrent || !dragSourceId) return null;

      const fromRoot = dragSourceId === 'ROOT';
      const sourcePos = fromRoot
        ? null
        : adjustedTokenPositions.find((p) => positionMatchesSpanId(p, dragSourceId));
      if (!fromRoot && !sourcePos) return null;

      const below = dragEnhanced;
      const y = TOKEN_Y - 10;
      // The band's baseline under a word, off the measured word.
      const baseUnder = (position) => {
        const measured = tokenPositions.find((p) => p.token?.id === position?.token?.id);
        return measured ? measured.y + (measured.height || 0) / 2 + LOWER_BAND_TOP : TREE_HEIGHT;
      };
      const cls = below ? 'tree-drag-arc tree-drag-arc--enhanced' : 'tree-drag-arc';
      const downArrow = (x, tipY) => `${x - 3},${tipY - 5} ${x + 3},${tipY - 5} ${x},${tipY}`;
      const upArrow = (x, tipY) => `${x - 3},${tipY + 5} ${x + 3},${tipY + 5} ${x},${tipY}`;
      const preview = (d, color, arrow, label) => (
        <g className={cls} style={{ color }}>
          <path d={d} />
          {arrow && <polygon points={arrow} />}
          {label && (
            <text x={label.x} y={label.y} className="tree-drag-label">
              {label.text}
            </text>
          )}
        </g>
      );
      const colorOf = (deprel) => resolveColor(baseRel(deprel), deprelColors);
      const GREY = '#6b7280';

      // The word this arc would land on if let go now.
      const hovered = hoveredToken?.token
        ? adjustedTokenPositions.find((p) => p.token?.id === hoveredToken.token.id)
        : null;
      const over = hovered || (below ? wordUnder(dragCurrent) : null);
      const target = over && (fromRoot || over !== sourcePos) ? over : null;
      const toRoot =
        !fromRoot && (hoveredToken?.lemmaSpanId === 'ROOT' || dragCurrent.y < ROOT_Y + 15);

      // A root. In the tree, the straight drop from the ROOT bar onto its word.
      // In the enhanced graph, the stub under it.
      if ((fromRoot && target) || toRoot) {
        const word = fromRoot ? target : sourcePos;
        if (below) {
          const base = baseUnder(word);
          return preview(
            `M ${word.x} ${base} l 0 ${ARC_BASE}`,
            colorOf('root'),
            upArrow(word.x, base - 5),
            { x: word.x, y: base + ARC_BASE + 11, text: 'root' },
          );
        }
        return preview(
          `M ${word.x} ${ROOT_Y + 10} L ${word.x} ${y}`,
          colorOf('root'),
          downArrow(word.x, y + 2),
          { x: word.x, y: (TOKEN_Y + ROOT_Y) / 2, text: 'root' },
        );
      }
      // Out of the ROOT bar and over no word yet. The bar is above the words
      // whichever graph this is for, so this one stretch is drawn from it.
      if (fromRoot) {
        const tipY = Math.max(dragCurrent.y, ROOT_Y + 15);
        return preview(
          `M ${dragCurrent.x} ${ROOT_Y + 10} L ${dragCurrent.x} ${tipY}`,
          GREY,
          downArrow(dragCurrent.x, tipY),
        );
      }

      // Between words. The end follows the hand, but never across the row of
      // words: an arc for the tree stays above it and one for the enhanced
      // graph below it, wherever the pointer goes.
      if (!target) {
        if (below) {
          const base = baseUnder(sourcePos);
          const tipY = Math.max(dragCurrent.y, base);
          return preview(
            handArcPath(sourcePos.x, base, dragCurrent.x, tipY, { down: true }),
            GREY,
            upArrow(dragCurrent.x, tipY - 5),
          );
        }
        const tipY = Math.min(dragCurrent.y, y);
        return preview(
          handArcPath(sourcePos.x, y, dragCurrent.x, tipY),
          GREY,
          downArrow(dragCurrent.x, tipY + 2),
        );
      }

      // Over a word. The level comes from the real stacking: every arc that
      // will still be there, plus this one.
      const columnOf = (spanId) =>
        adjustedTokenPositions.find((p) => positionMatchesSpanId(p, spanId))?.index;
      const spansOf = (rels) =>
        rels
          .filter((rel) => rel.source !== rel.target)
          .map((rel) => [columnOf(rel.source), columnOf(rel.target)])
          .filter(([a, b]) => a !== undefined && b !== undefined)
          .map(([a, b], i) => ({ id: i, left: Math.min(a, b), right: Math.max(a, b) }));
      const left = Math.min(sourcePos.index, target.index);
      const right = Math.max(sourcePos.index, target.index);
      const deprel = incomingDeprel(target);
      const offset = target.x > sourcePos.x ? 5 : -5;

      if (below) {
        const base = baseUnder(target);
        const height = arcHeight(levelAmong(spansOf(extras), left, right));
        return preview(
          arcPath(sourcePos.x + offset, target.x, base, -height),
          colorOf(deprel),
          upArrow(target.x, base - 5),
          { x: (sourcePos.x + target.x) / 2, y: base + height + 11, text: deprel },
        );
      }

      // A re-pointed head replaces the word's present one, which is not among
      // the arcs this one will share the tree with.
      const staying = relations.filter((rel) => !positionMatchesSpanId(target, rel.target));
      const height = arcHeight(levelAmong(spansOf(staying), left, right));
      return preview(
        arcPath(sourcePos.x + offset, target.x, y, height),
        colorOf(deprel),
        downArrow(target.x, y + 2),
        { x: (sourcePos.x + target.x) / 2, y: y - height - 5, text: deprel },
      );
    };

    // Calculate SVG width based on actual token positions
    const minSvgWidth =
      adjustedTokenPositions.length > 0
        ? Math.max(...adjustedTokenPositions.map((p) => p.x)) + 50
        : 300;

    return (
      <div className="dependency-tree-container">
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
            height="20"
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
            // Use token width if available, otherwise default to 60px
            const tokenWidth = position.width || 60;
            const tokenHeight = 30;

            return (
              <rect
                key={position.token.id}
                x={position.x - tokenWidth * 0.6}
                y={position.y - tokenHeight * 0.6 + 10}
                width={tokenWidth * 1.2}
                height={tokenHeight * 1.2}
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
