import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { provState, PROV_STATES } from '@larc-iu/plaid-client';
import { resolveColor, baseRel } from '../../../utils/udVocab.js';
import { provCellTitle } from '../../../utils/provenanceUi.js';
import { DeprelEditor } from './DeprelEditor.jsx';
import './DependencyTree.css';

// Machine-made, not yet human-verified (provenance convention) — the deprel
// label renders distinctly until a human edits it (which verifies it).
const isInferredRelation = (relation) => provState(relation?.metadata) === PROV_STATES.MACHINE;

// The "unapproved" violet, matching the inferred annotation cells. Paired with a
// dashed stroke so the unapproved state never relies on color alone (a configured
// DEPREL color could itself be purple — see the dash below).
const INFERRED_COLOR = '#6d28d9';

export const DependencyTree = forwardRef(({
  tokens,
  relations,
  lemmaSpans,
  onRelationCreate,
  onRelationUpdate,
  onRelationDelete,
  textContent,
  tokenPositions = [],
  deprelColors,
  deprelVocab,
  onExitDown
}, ref) => {
  const [selectedSource, setSelectedSource] = useState(null);
  const [hoveredToken, setHoveredToken] = useState(null);
  const [editingRelation, setEditingRelation] = useState(null);
  const [hoveredRelation, setHoveredRelation] = useState(null);
  const [focusedRelation, setFocusedRelation] = useState(null);
  const [dragOrigin, setDragOrigin] = useState(null);
  const [dragCurrent, setDragCurrent] = useState(null);
  const [dragSourceId, setDragSourceId] = useState(null);
  const [positionsInitialized, setPositionsInitialized] = useState(false);
  const svgRef = useRef(null);
  const labelRefs = useRef(new Map());

  // Constants for layout (back to original working version)
  const TOKEN_SPACING = 80;
  const TREE_HEIGHT = 300;
  const PADDING = 20;
  const TOKEN_Y = TREE_HEIGHT - 30; // Tokens at bottom
  const ROOT_Y = 25; // ROOT bar at top

  const getEffectiveSpanId = (position) => {
    if (!position) return null;
    return position.lemmaSpanId || position.token?.id || null;
  };

  const positionMatchesSpanId = (position, spanId) => {
    if (!position || !spanId) return false;
    if (position.lemmaSpanId && position.lemmaSpanId === spanId) {
      return true;
    }
    return position.token?.id === spanId;
  };

  // When re-pointing a token's head (it already has an incoming arc), keep its
  // existing deprel instead of resetting to 'dep'. A root self-loop is excluded
  // (a non-root head shouldn't inherit 'root').
  const incomingDeprel = (targetPosition) => {
    const prev = relations.find(rel =>
      positionMatchesSpanId(targetPosition, rel.target) && rel.source !== rel.target
    );
    return prev?.value || 'dep';
  };

  // Use passed token positions for X coordinates, but keep original Y logic
  const adjustedTokenPositions = tokenPositions.length > 0 
    ? tokenPositions.map((pos, index) => ({
        ...pos,
        y: TOKEN_Y // Use original TOKEN_Y for consistent arc drawing
      }))
    : tokens.map((token, index) => {
        // `textContent` is the provider object from SentenceRow (a `.substring`
        // that resolves a token's form by exact begin/end), NOT a raw string —
        // don't slice it. This fallback runs on the first render after tokens
        // appear (e.g. just after a parse) before token positions are measured.
        const tokenForm = textContent.substring(token.begin, token.end);
        const matchingLemmaSpan = lemmaSpans.find(span =>
          (span.tokens && span.tokens.includes(token.id)) || span.begin === token.id
        );
        
        return {
          token,
          x: PADDING + index * TOKEN_SPACING + TOKEN_SPACING / 2,
          y: TOKEN_Y,
          form: tokenForm,
          lemmaSpanId: matchingLemmaSpan?.id,
          index: index
        };
      });

  // Use a modified logistic function to compute how high an arc should go
  const getMaxHeight = (src, dest) => {
    const diff = Math.abs(dest - src);
    const expTerm = -0.2 * Math.pow(diff, 0.8);
    const denom = 1 + Math.exp(expTerm);
    const raw = 1 / denom;
    // Cap the maximum height to prevent clipping and ensure reasonable arcs
    const maxAllowedHeight = TREE_HEIGHT - ROOT_Y - 40; // Leave room for ROOT and tokens
    const calculatedHeight = maxAllowedHeight * ((raw - 0.5) * 2);
    return Math.max(15, Math.min(calculatedHeight, maxAllowedHeight * 0.8));
  };

  // Generate SVG path for dependency arc (restored original logic)
  const computeEdge = (sourcePos, targetPos, isToRoot = false, isFromRoot = false) => {
    const x = sourcePos.x;
    const y = isFromRoot ? sourcePos.y : TOKEN_Y - 10;
    const destX = targetPos.x;
    const destY = isToRoot ? ROOT_Y + 10 : TOKEN_Y - 10;
    const dx = destX - x;
    const dy = destY - y;
    const maxHeight = (isToRoot || isFromRoot) ? null : getMaxHeight(sourcePos.index, targetPos.index);
    const offset = destX > x ? 5 : -5;
    
    let d;
    
    // We're drawing to the root or from the root
    if (maxHeight === null) {
      d = `M ${x} ${y} l ${dx} ${dy}`;
    } 
    // We're drawing a new edge from the root
    else if (y === ROOT_Y + 10) {
      d = `M ${x} ${y} 
           c 0 0, ${dx} -${maxHeight/4}, ${dx} ${dy}`;
    } 
    else if (dy !== 0) {
      d = `M ${x} ${y} 
           c 0 -${maxHeight}, ${dx} -${maxHeight}, ${dx} ${dy}`;
    }
    // We're drawing a normal static edge
    else {
      d = `M ${x + offset} ${y} 
           a ${Math.abs(dx - offset)/2} ${maxHeight} 0 0 ${x < destX ? "1" : "0"} ${dx - offset} 0`;
    }
    
    return d;
  };

  // Editing is disabled (read-only) whenever the parent withholds the relation
  // handlers — i.e. for viewer access or while viewing a past state. Guard every
  // interaction entry point so drawing/label-editing can't start (and so calling
  // a null handler can never throw).
  const isReadOnly = !onRelationCreate;

  // Handle mouse down on token (start drag)
  const handleTokenMouseDown = (e, position) => {
    e.preventDefault();
    if (isReadOnly) return;
    if (editingRelation) {
      setEditingRelation(null);
      return;
    }
    
    setDragOrigin({ x: position.x, y: position.y });
    setDragCurrent({ x: position.x, y: position.y });
    setDragSourceId(getEffectiveSpanId(position));
  };

  // Handle mouse move on SVG (update drag)
  const handleSvgMouseMove = (e) => {
    if (dragOrigin && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      setDragCurrent({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
    }
  };

  // Handle mouse up on token (complete drag)
  const handleTokenMouseUp = (e, position) => {
    e.stopPropagation();
    if (isReadOnly) return;
    if (dragOrigin && dragSourceId) {
      const sourceId = dragSourceId;
      const targetId = getEffectiveSpanId(position);
      const sourcePosition = adjustedTokenPositions.find(p => positionMatchesSpanId(p, sourceId));
      const targetPosition = position;
      
      // Handle drag FROM ROOT to token
      if (sourceId === 'ROOT' && targetId) {
        // Look for existing ROOT relation (self-pointing relation)
        const existingRelation = relations.find(rel => 
          positionMatchesSpanId(targetPosition, rel.source) &&
          positionMatchesSpanId(targetPosition, rel.target)
        );
        
        if (existingRelation) {
          setEditingRelation(existingRelation);
        } else {
          onRelationCreate(targetId, targetId, 'root'); // Self-pointing relation
        }
      }
      // Handle drag FROM token to token
      else if (sourceId !== targetId && sourceId !== 'ROOT' && targetId) {
        const existingRelation = relations.find(rel => 
          positionMatchesSpanId(sourcePosition, rel.source) &&
          positionMatchesSpanId(targetPosition, rel.target)
        );
        
        if (existingRelation) {
          setEditingRelation(existingRelation);
        } else {
          if (sourceId && targetId) {
            onRelationCreate(sourceId, targetId, incomingDeprel(targetPosition));
          }
        }
      }
    }

    // Reset drag state
    setDragOrigin(null);
    setDragCurrent(null);
    setDragSourceId(null);
  };

  // Handle mouse down on ROOT (start drag from ROOT)
  const handleRootMouseDown = (e) => {
    e.preventDefault();
    if (isReadOnly) return;
    if (editingRelation) {
      setEditingRelation(null);
      return;
    }
    
    // Get the exact click position on the ROOT bar
    const rect = svgRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    setDragOrigin({ x: clickX, y: clickY });
    setDragCurrent({ x: clickX, y: clickY });
    setDragSourceId('ROOT');
  };

  // Handle mouse up on ROOT (when dragging TO ROOT)
  const handleRootMouseUp = (e) => {
    e.stopPropagation();
    if (isReadOnly) return;
    if (dragOrigin && dragSourceId && dragSourceId !== 'ROOT') {
      const sourceId = dragSourceId;
      const sourcePosition = adjustedTokenPositions.find(p => positionMatchesSpanId(p, sourceId));
      
      // Look for existing ROOT relation (self-pointing relation)
      const existingRelation = relations.find(rel => 
        positionMatchesSpanId(sourcePosition, rel.source) &&
        positionMatchesSpanId(sourcePosition, rel.target)
      );
      
      if (existingRelation) {
        setEditingRelation(existingRelation);
      } else {
        onRelationCreate(sourceId, sourceId, 'root'); // Self-pointing relation
      }
    }
    
    // Reset drag state
    setDragOrigin(null);
    setDragCurrent(null);
    setDragSourceId(null);
  };

  // Handle mouse up on SVG (cancel drag)
  const handleSvgMouseUp = (e) => {
    // Reset drag state if not dropped on a valid target
    setDragOrigin(null);
    setDragCurrent(null);
    setDragSourceId(null);
  };

  // Handle token click for relation creation (fallback to click-click)
  const handleTokenClick = (position) => {
    if (isReadOnly) return;
    if (editingRelation) {
      setEditingRelation(null);
      return;
    }

    const spanId = getEffectiveSpanId(position);

    if (!selectedSource) {
      setSelectedSource({ ...position, spanId });
    } else if (
      selectedSource.spanId === spanId ||
      selectedSource.token?.id === position.token?.id
    ) {
      setSelectedSource(null);
    } else {
      const sourceId = selectedSource.spanId;
      const targetId = spanId;
      const sourcePosition = adjustedTokenPositions.find(p => positionMatchesSpanId(p, sourceId));
      const targetPosition = adjustedTokenPositions.find(p => positionMatchesSpanId(p, targetId)) || position;
      
      const existingRelation = relations.find(rel => 
        positionMatchesSpanId(sourcePosition, rel.source) &&
        positionMatchesSpanId(targetPosition, rel.target)
      );
      
      if (existingRelation) {
        setEditingRelation(existingRelation);
      } else {
        if (sourceId && targetId) {
          onRelationCreate(sourceId, targetId, incomingDeprel(targetPosition));
        }
      }

      setSelectedSource(null);
    }
  };

  // Handle ROOT click
  const handleRootClick = (x) => {
    if (isReadOnly) return;
    if (selectedSource && selectedSource.spanId !== 'ROOT') {
      const sourceId = selectedSource.spanId;
      const sourcePosition = adjustedTokenPositions.find(p => positionMatchesSpanId(p, sourceId)) || selectedSource;
      
      // Look for existing ROOT relation (self-pointing relation)
      const existingRelation = relations.find(rel => 
        positionMatchesSpanId(sourcePosition, rel.source) &&
        positionMatchesSpanId(sourcePosition, rel.target)
      );
      
      if (existingRelation) {
        setEditingRelation(existingRelation);
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
      const sourcePos = adjustedTokenPositions.find(p => positionMatchesSpanId(p, relation.source));
      
      if (isSelfPointing) {
        // ROOT relation - label is centered above the source token
        return sourcePos?.x || 0;
      } else {
        // Regular relation - label is at midpoint between source and target
        const targetPos = adjustedTokenPositions.find(p => positionMatchesSpanId(p, relation.target));
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
    if (e.key === 'd' && e.ctrlKey && !focusedRelation && !editingRelation) {
      e.preventDefault();
      focusFirstRelation();
      return;
    }
    if (e.key === 'Escape') {
      setSelectedSource(null);
      setEditingRelation(null);
      setFocusedRelation(null);
      setDragOrigin(null);
      setDragCurrent(null);
      setDragSourceId(null);
    }
  };

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
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
    }
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
  const renderArc = (relation) => {
    // Check if this is a self-pointing relation (ROOT relation)
    const isSelfPointing = relation.source === relation.target;
    
    const sourcePos = adjustedTokenPositions.find(p => positionMatchesSpanId(p, relation.source));
    const targetPos = isSelfPointing
      ? { x: sourcePos?.x || 0, y: ROOT_Y, index: -1 }
      : adjustedTokenPositions.find(p => positionMatchesSpanId(p, relation.target));
    
    if (!sourcePos || (!targetPos && !isSelfPointing)) {
      return null;
    }
    
    const isSelected = editingRelation?.id === relation.id;
    const isHovered = hoveredRelation === relation.id;
    const isFocused = focusedRelation === relation.id;
    const isToRoot = isSelfPointing;
    
    const pathData = computeEdge(sourcePos, targetPos, isToRoot);
    const pathId = `arc-${relation.id}`;
    
    // Calculate arrow position - for ROOT relations, arrow points to the token
    const arrowX = isToRoot ? sourcePos.x : targetPos.x;
    const arrowY = isToRoot ? TOKEN_Y - 10 : TOKEN_Y - 10;
    
    // Calculate label position
    let labelX, labelY;
    if (isToRoot) {
      labelX = sourcePos.x;
      labelY = (TOKEN_Y + ROOT_Y) / 2;
    } else {
      const midX = (sourcePos.x + targetPos.x) / 2;
      const height = getMaxHeight(sourcePos.index, targetPos.index);
      labelY = TOKEN_Y - height - 15;
      labelX = midX;
    }
    
    // Unapproved (machine) relations read as "unapproved" violet + a dashed
    // stroke — the dash is the unambiguous cue, so it can't be confused with an
    // APPROVED relation whose configured DEPREL color happens to be purple.
    // Approved relations color by the base DEPREL (configured map → deterministic
    // auto); selection/hover/focus keep the highlight blue. `color` drives the
    // arc stroke, arrowhead fill, and resting label fill, so the label matches.
    const inferred = isInferredRelation(relation);
    const active = isSelected || isHovered || isFocused;
    const restColor = inferred ? INFERRED_COLOR : resolveColor(baseRel(relation.value || 'dep'), deprelColors);
    const color = active ? '#2563eb' : restColor;
    const strokeWidth = active ? 2 : 1;
    
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
          className="tree-arc-path"
          onMouseEnter={() => setHoveredRelation(relation.id)}
          onMouseLeave={() => setHoveredRelation(null)}
          onClick={() => { if (!isReadOnly) setEditingRelation(relation); }}
        />

        {/* Arrow polygon */}
        <polygon
          points={`${arrowX-3},${arrowY - 3} ${arrowX+3},${arrowY - 3} ${arrowX},${arrowY + 2}`}
          fill={color}
          className="tree-arc-arrow"
          onClick={() => { if (!isReadOnly) setEditingRelation(relation); }}
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
              suggestions={deprelVocab}
              onCommit={(v) => {
                const t = (v || '').trim();
                if (t && t !== (relation.value || 'dep')) onRelationUpdate(relation.id, t);
                // Stay on this label (selected, not editing) so arrow/Tab nav
                // continues; the refocus effect returns focus to its <text>.
                setEditingRelation(null);
                setFocusedRelation(relation.id);
              }}
              onCancel={() => { setEditingRelation(null); setFocusedRelation(relation.id); }}
              onDelete={() => {
                onRelationDelete(relation.id);
                setEditingRelation(null);
                setFocusedRelation(null);
              }}
              onTab={(v, shiftKey) => {
                const t = (v || '').trim();
                if (t && t !== (relation.value || 'dep')) onRelationUpdate(relation.id, t);
                const idx = sortedRelations.findIndex(r => r.id === relation.id);
                const nextIdx = shiftKey
                  ? (idx > 0 ? idx - 1 : sortedRelations.length - 1)
                  : (idx < sortedRelations.length - 1 ? idx + 1 : 0);
                const next = sortedRelations[nextIdx];
                setEditingRelation(next || null);
                setFocusedRelation(next?.id || null);
              }}
            />
          </foreignObject>
        ) : (
          <text
            x={labelX}
            y={labelY}
            fill={color}
            className={`tree-deprel-text ${isFocused ? 'tree-deprel-text--focused' : ''}${isInferredRelation(relation) ? ' tree-deprel-text--inferred' : ''}`}
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
                if (!isReadOnly) setEditingRelation(relation);
              } else if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
                e.preventDefault();
                selectAdjacentRelation(relation.id, 1);
              } else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault();
                selectAdjacentRelation(relation.id, -1);
              } else if (e.key === 'ArrowDown') {
                // Drop into the grid: this label's dependent token column.
                const tid = tokenIdForRelation(relation);
                if (tid && onExitDown) { e.preventDefault(); onExitDown(tid); }
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setFocusedRelation(null);
                e.currentTarget.blur();
              }
            }}
            onClick={() => {
              if (isReadOnly) return;
              setEditingRelation(relation);
              setFocusedRelation(relation.id);
            }}
            ref={(el) => {
              if (el) {
                labelRefs.current.set(relation.id, el);
              } else {
                labelRefs.current.delete(relation.id);
              }
            }}
          >
            {relation.value || 'dep'}
            {/* Hover record for machine-made relations (SVG-native tooltip). */}
            {provState(relation.metadata) !== PROV_STATES.HUMAN && (
              <title>{provCellTitle('deprel', relation.metadata)}</title>
            )}
          </text>
        )}
      </>
    );

    return { key: relation.id, body, label };
  };

  // Render drag arrow during mouse drag
  const renderDragArc = () => {
    if (!dragOrigin || !dragCurrent || !dragSourceId) {
      return null;
    }
    
    let originX, originY;
    
    // Handle dragging FROM ROOT
    if (dragSourceId === 'ROOT') {
      originX = dragOrigin.x; // Use exact click position
      originY = dragOrigin.y;
    } else {
      // Handle dragging FROM token
      const sourcePos = adjustedTokenPositions.find(p => positionMatchesSpanId(p, dragSourceId));
      if (!sourcePos) return null;
      originX = sourcePos.x;
      originY = TOKEN_Y - 10;
    }
    
    const dx = dragCurrent.x - originX;
    const dy = dragCurrent.y - originY;
    
    // Generate path using the same logic as static arcs
    let pathData;
    
    // For ROOT drags, use a simple line initially, then curve as we approach tokens
    if (dragSourceId === 'ROOT') {
      const isTowardToken = dragCurrent.y > ROOT_Y + 30;
      if (isTowardToken) {
        // Create a curved path from ROOT downward
        const maxHeight = Math.abs(dy) * 0.3;
        pathData = `M ${originX} ${originY} 
             c 0 ${maxHeight}, ${dx} ${maxHeight}, ${dx} ${dy}`;
      } else {
        // Simple line for short drags
        pathData = `M ${originX} ${originY} l ${dx} ${dy}`;
      }
    } else {
      // Existing logic for token-to-token drags
      const isToRoot = dragCurrent.y < ROOT_Y + 15;
      const maxHeight = isToRoot ? null : getMaxHeight(0, -1);
      const offset = dx > 0 ? 5 : -5;
      
      if (maxHeight === null) {
        pathData = `M ${originX} ${originY} l ${dx} ${dy}`;
      } else if (dy !== 0) {
        pathData = `M ${originX} ${originY} 
             c 0 -${maxHeight}, ${dx} -${maxHeight}, ${dx} ${dy}`;
      } else {
        pathData = `M ${originX + offset} ${originY} 
             a ${Math.abs(dx - offset)/2} ${maxHeight} 0 0 ${originX < originX + dx ? "1" : "0"} ${dx - offset} 0`;
      }
    }
    
    return (
      <path
        d={pathData}
        className="tree-drag-arc"
      />
    );
  };

  // Calculate SVG width based on actual token positions
  const minSvgWidth = adjustedTokenPositions.length > 0 
    ? Math.max(...adjustedTokenPositions.map(p => p.x)) + 50 
    : 300;

  return (
    <div className="dependency-tree-container">
      <svg
        ref={svgRef}
        width="100%"
        height={TREE_HEIGHT}
        className="tree-svg"
        style={{ minWidth: `${minSvgWidth}px` }}
        onMouseMove={handleSvgMouseMove}
        onMouseUp={handleSvgMouseUp}
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
        {positionsInitialized && (() => {
          const arcs = relations.map((relation, index) => renderArc(relation, index)).filter(Boolean);
          return (
            <>
              {arcs.map(a => <g key={a.key}>{a.body}</g>)}
              {arcs.map(a => <g key={`${a.key}-label`}>{a.label}</g>)}
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
              x={position.x - (tokenWidth * 0.6)}
              y={position.y - (tokenHeight * 0.6) + 10}
              width={tokenWidth * 1.2}
              height={tokenHeight * 1.2}
              fill="transparent"
              className={`tree-token-area ${dragOrigin ? 'tree-token-area--drag' : 'tree-token-area--grab'}`}
              onClick={() => handleTokenClick(position)}
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
});

DependencyTree.displayName = 'DependencyTree';
