import { useState, useRef, useEffect } from 'react';
import './DependencyTree.css';

export const DependencyTree = ({
  tokens, 
  relations, 
  lemmaSpans,
  onRelationCreate,
  onRelationUpdate,
  onRelationDelete,
  textContent,
  tokenPositions = [] 
}) => {
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

  // Use passed token positions for X coordinates, but keep original Y logic
  const adjustedTokenPositions = tokenPositions.length > 0 
    ? tokenPositions.map((pos, index) => ({
        ...pos,
        y: TOKEN_Y // Use original TOKEN_Y for consistent arc drawing
      }))
    : tokens.map((token, index) => {
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

  // Handle mouse down on token (start drag)
  const handleTokenMouseDown = (e, position) => {
    e.preventDefault();
    if (editingRelation) {
      setEditingRelation(null);
      return;
    }
    
    setDragOrigin({ x: position.x, y: position.y });
    setDragCurrent({ x: position.x, y: position.y });
    setDragSourceId(position.lemmaSpanId);
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
    if (dragOrigin && dragSourceId) {
      const sourceId = dragSourceId;
      const targetId = position.lemmaSpanId;
      
      // Handle drag FROM ROOT to token
      if (sourceId === 'ROOT' && targetId) {
        // Look for existing ROOT relation (self-pointing relation)
        const existingRelation = relations.find(rel => 
          rel.source === targetId && rel.target === targetId
        );
        
        if (existingRelation) {
          setEditingRelation(existingRelation);
        } else {
          onRelationCreate(targetId, targetId, 'root'); // Self-pointing relation
        }
      }
      // Handle drag FROM token to token
      else if (sourceId !== targetId && sourceId !== 'ROOT') {
        const existingRelation = relations.find(rel => 
          rel.source === sourceId && rel.target === targetId
        );
        
        if (existingRelation) {
          setEditingRelation(existingRelation);
        } else {
          if (sourceId && targetId) {
            onRelationCreate(sourceId, targetId, 'dep');
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
    if (dragOrigin && dragSourceId && dragSourceId !== 'ROOT') {
      const sourceId = dragSourceId;
      
      // Look for existing ROOT relation (self-pointing relation)
      const existingRelation = relations.find(rel => 
        rel.source === sourceId && rel.target === sourceId
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
    if (editingRelation) {
      setEditingRelation(null);
      return;
    }

    if (!selectedSource) {
      setSelectedSource(position);
    } else if (selectedSource.lemmaSpanId === position.lemmaSpanId) {
      setSelectedSource(null);
    } else {
      const sourceId = selectedSource.lemmaSpanId;
      const targetId = position.lemmaSpanId;
      
      const existingRelation = relations.find(rel => 
        rel.source === sourceId && rel.target === targetId
      );
      
      if (existingRelation) {
        setEditingRelation(existingRelation);
      } else {
        if (sourceId && targetId) {
          onRelationCreate(sourceId, targetId, 'dep');
        }
      }
      
      setSelectedSource(null);
    }
  };

  // Handle ROOT click
  const handleRootClick = (x) => {
    if (selectedSource && selectedSource.lemmaSpanId !== 'ROOT') {
      const sourceId = selectedSource.lemmaSpanId;
      
      // Look for existing ROOT relation (self-pointing relation)
      const existingRelation = relations.find(rel => 
        rel.source === sourceId && rel.target === sourceId
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
      const sourcePos = adjustedTokenPositions.find(p => p.lemmaSpanId === relation.source);
      
      if (isSelfPointing) {
        // ROOT relation - label is centered above the source token
        return sourcePos?.x || 0;
      } else {
        // Regular relation - label is at midpoint between source and target
        const targetPos = adjustedTokenPositions.find(p => p.lemmaSpanId === relation.target);
        return ((sourcePos?.x || 0) + (targetPos?.x || 0)) / 2;
      }
    };
    
    return getLabelX(a) - getLabelX(b);
  });

  // Handle keyboard navigation
  const handleKeyDown = (e) => {
    // Handle initial focus with Ctrl+D (for Dependency labels)
    if (e.key === 'd' && e.ctrlKey && !focusedRelation && !editingRelation) {
      e.preventDefault();
      focusFirstRelation();
      return;
    }
    
    // Handle Tab navigation for dependency labels
    if (e.key === 'Tab' && focusedRelation) {
      e.preventDefault();
      const currentIndex = sortedRelations.findIndex(r => r.id === focusedRelation);
      
      if (e.shiftKey) {
        // Shift+Tab: Previous relation
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : sortedRelations.length - 1;
        if (sortedRelations[prevIndex]) {
          setFocusedRelation(sortedRelations[prevIndex].id);
          const labelElement = labelRefs.current.get(sortedRelations[prevIndex].id);
          labelElement?.focus();
        }
      } else {
        // Tab: Next relation
        const nextIndex = currentIndex < sortedRelations.length - 1 ? currentIndex + 1 : 0;
        if (sortedRelations[nextIndex]) {
          setFocusedRelation(sortedRelations[nextIndex].id);
          const labelElement = labelRefs.current.get(sortedRelations[nextIndex].id);
          labelElement?.focus();
        }
      }
      return;
    }
    
    // Handle Escape key
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
    
    const sourcePos = adjustedTokenPositions.find(p => p.lemmaSpanId === relation.source);
    const targetPos = isSelfPointing
      ? { x: sourcePos?.x || 0, y: ROOT_Y, index: -1 }
      : adjustedTokenPositions.find(p => p.lemmaSpanId === relation.target);
    
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
    
    const color = isSelected || isHovered || isFocused ? '#2563eb' : '#666';
    const strokeWidth = isSelected || isHovered || isFocused ? 2 : 1;
    
    return (
      <g key={relation.id}>
        {/* Arc path */}
        <path
          id={pathId}
          d={pathData}
          stroke={color}
          strokeWidth={strokeWidth}
          className="tree-arc-path"
          onMouseEnter={() => setHoveredRelation(relation.id)}
          onMouseLeave={() => setHoveredRelation(null)}
          onClick={() => {
            setEditingRelation(relation);
          }}
        />
        
        {/* Arrow polygon */}
        <polygon 
          points={`${arrowX-3},${arrowY - 3} ${arrowX+3},${arrowY - 3} ${arrowX},${arrowY + 2}`} 
          fill={color}
          className="tree-arc-arrow"
          onClick={() => {
            setEditingRelation(relation);
          }}
        />
        
        {/* DEPREL label */}
        {editingRelation?.id === relation.id ? (
          <foreignObject
            x={labelX - 40}
            y={labelY - 10}
            width="80"
            height="20"
          >
            <div
              contentEditable
              suppressContentEditableWarning
              className="tree-deprel-edit"
              onBlur={(e) => {
                const newValue = e.target.textContent.trim();
                const currentValue = relation.value || 'dep';
                if (newValue && newValue !== currentValue) {
                  onRelationUpdate(relation.id, newValue);
                }
                setEditingRelation(null);
                
                // Only restore focus if the user isn't focusing on something else
                // Check if the related target has a tabIndex (indicating it's an EditableCell or other focusable element)
                const relatedTarget = e.relatedTarget;
                const isMovingToEditableCell = relatedTarget && relatedTarget.getAttribute && relatedTarget.getAttribute('tabIndex') !== null && relatedTarget.getAttribute('tabIndex') !== '-1';
                
                if (!isMovingToEditableCell) {
                  // Restore focus to the label after editing
                  setTimeout(() => {
                    const labelElement = labelRefs.current.get(relation.id);
                    if (labelElement) {
                      labelElement.focus();
                      setFocusedRelation(relation.id);
                    }
                  }, 0);
                } else {
                  // Clear focus state when moving to another element
                  setFocusedRelation(null);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.target.blur();
                } else if (e.key === 'Escape') {
                  e.target.textContent = relation.value || 'dep';
                  setEditingRelation(null);
                  setFocusedRelation(null);
                } else if (e.key === 'Delete' && e.shiftKey) {
                  e.preventDefault();
                  onRelationDelete(relation.id);
                  setEditingRelation(null);
                  setFocusedRelation(null);
                } else if (e.key === 'Tab') {
                  // Handle tab navigation during editing
                  e.preventDefault();
                  const newValue = e.target.textContent.trim();
                  const currentValue = relation.value || 'dep';
                  
                  // Save changes if different
                  if (newValue && newValue !== currentValue) {
                    onRelationUpdate(relation.id, newValue);
                  }
                  
                  // Navigate to next/previous relation
                  setEditingRelation(null);
                  const currentIndex = sortedRelations.findIndex(r => r.id === relation.id);
                  
                  if (e.shiftKey) {
                    // Shift+Tab: Previous relation
                    const prevIndex = currentIndex > 0 ? currentIndex - 1 : sortedRelations.length - 1;
                    if (sortedRelations[prevIndex]) {
                      setTimeout(() => {
                        setFocusedRelation(sortedRelations[prevIndex].id);
                        const labelElement = labelRefs.current.get(sortedRelations[prevIndex].id);
                        labelElement?.focus();
                      }, 0);
                    }
                  } else {
                    // Tab: Next relation
                    const nextIndex = currentIndex < sortedRelations.length - 1 ? currentIndex + 1 : 0;
                    if (sortedRelations[nextIndex]) {
                      setTimeout(() => {
                        setFocusedRelation(sortedRelations[nextIndex].id);
                        const labelElement = labelRefs.current.get(sortedRelations[nextIndex].id);
                        labelElement?.focus();
                      }, 0);
                    }
                  }
                }
              }}
              autoFocus
              ref={(el) => {
                if (el) {
                  el.textContent = relation.value || 'dep';
                  // Select all text
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              }}
            >{relation.value || 'dep'}</div>
          </foreignObject>
        ) : (
          <text
            x={labelX}
            y={labelY}
            fill={color}
            className={`tree-deprel-text ${isFocused ? 'tree-deprel-text--focused' : ''}`}
            tabIndex="-1"
            onMouseEnter={() => setHoveredRelation(relation.id)}
            onMouseLeave={() => setHoveredRelation(null)}
            onFocus={() => {
              setFocusedRelation(relation.id);
              setEditingRelation(relation);
            }}
            onBlur={() => {
              // Only clear focus if we're not editing
              if (!editingRelation) {
                setFocusedRelation(null);
              }
            }}
            onClick={() => {
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
          </text>
        )}
      </g>
    );
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
      const sourcePos = adjustedTokenPositions.find(p => p.lemmaSpanId === dragSourceId);
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
        
        {/* Render existing relations - only when positions are initialized */}
        {positionsInitialized && relations.map((relation, index) => renderArc(relation, index))}
        
        {/* Render drag arc - only when positions are initialized */}
        {positionsInitialized && renderDragArc()}
        
        {/* Invisible token click areas */}
        {adjustedTokenPositions.map((position) => {
          const isSource = selectedSource?.lemmaSpanId === position.lemmaSpanId;
          const isHovered = hoveredToken?.lemmaSpanId === position.lemmaSpanId;
          const isDragSource = dragSourceId === position.lemmaSpanId;
          
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
};