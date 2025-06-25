import { useState, useRef, useEffect } from 'react';

export const DependencyTree = ({ 
  tokens, 
  relations, 
  lemmaSpans,
  onRelationCreate,
  onRelationUpdate,
  onRelationDelete,
  textContent 
}) => {
  const [selectedSource, setSelectedSource] = useState(null);
  const [hoveredToken, setHoveredToken] = useState(null);
  const [editingRelation, setEditingRelation] = useState(null);
  const [hoveredRelation, setHoveredRelation] = useState(null);
  const [dragOrigin, setDragOrigin] = useState(null);
  const [dragCurrent, setDragCurrent] = useState(null);
  const [dragSourceId, setDragSourceId] = useState(null);
  const svgRef = useRef(null);

  // Constants for layout
  const TOKEN_SPACING = 80;
  const TREE_HEIGHT = 250; // Increased height to prevent clipping
  const PADDING = 20;
  const TOKEN_Y = TREE_HEIGHT - 30; // Tokens at bottom
  const ROOT_Y = 25; // ROOT bar at top

  // Get token form (text)
  const getTokenForm = (token) => {
    if (token.id === 'ROOT') return 'ROOT';
    return textContent.substring(token.begin, token.end);
  };

  // Calculate token positions
  const tokenPositions = tokens.map((token, index) => {
    const tokenForm = getTokenForm(token);
    
    // Find lemma span for this token
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
    const expTerm = -0.5 * diff;
    const denom = 1 + Math.exp(expTerm);
    const raw = 1 / denom;
    // Cap the maximum height to prevent clipping and ensure reasonable arcs
    const maxAllowedHeight = TREE_HEIGHT - ROOT_Y - 40; // Leave room for ROOT and tokens
    const calculatedHeight = maxAllowedHeight * ((raw - 0.5) * 2);
    return Math.max(15, Math.min(calculatedHeight, maxAllowedHeight * 0.8));
  };

  // Generate SVG path for dependency arc
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
        const existingRelation = relations.find(rel => 
          rel.source === targetId && rel.target === 'ROOT'
        );
        
        if (existingRelation) {
          setEditingRelation(existingRelation);
        } else {
          onRelationCreate(targetId, 'ROOT', 'root');
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
      
      const existingRelation = relations.find(rel => 
        rel.source === sourceId && rel.target === 'ROOT'
      );
      
      if (existingRelation) {
        setEditingRelation(existingRelation);
      } else {
        onRelationCreate(sourceId, 'ROOT', 'root');
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
      
      const existingRelation = relations.find(rel => 
        rel.source === sourceId && rel.target === 'ROOT'
      );
      
      if (existingRelation) {
        setEditingRelation(existingRelation);
      } else {
        onRelationCreate(sourceId, 'ROOT', 'root');
      }
      
      setSelectedSource(null);
    }
  };

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setSelectedSource(null);
        setEditingRelation(null);
        setDragOrigin(null);
        setDragCurrent(null);
        setDragSourceId(null);
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);



  // Render dependency arc
  const renderArc = (relation) => {
    const sourcePos = tokenPositions.find(p => p.lemmaSpanId === relation.source);
    const targetPos = relation.target === 'ROOT' 
      ? { x: sourcePos?.x || 0, y: ROOT_Y, index: -1 }
      : tokenPositions.find(p => p.lemmaSpanId === relation.target);
    
    if (!sourcePos || (!targetPos && relation.target !== 'ROOT')) {
      return null;
    }
    
    const isSelected = editingRelation?.id === relation.id;
    const isHovered = hoveredRelation === relation.id;
    const isToRoot = relation.target === 'ROOT';
    
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
    
    const color = isSelected || isHovered ? '#2563eb' : '#666';
    const strokeWidth = isSelected || isHovered ? 2 : 1;
    
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
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.target.blur();
                } else if (e.key === 'Escape') {
                  e.target.textContent = relation.value || 'dep';
                  setEditingRelation(null);
                } else if (e.key === 'Delete' && e.shiftKey) {
                  e.preventDefault();
                  onRelationDelete(relation.id);
                  setEditingRelation(null);
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
            className="tree-deprel-text"
            onMouseEnter={() => setHoveredRelation(relation.id)}
            onMouseLeave={() => setHoveredRelation(null)}
            onClick={() => {
              setEditingRelation(relation);
            }}
          >
            {relation.value || 'dep'}
          </text>
        )}
      </g>
    );
  };

  // Render temporary arc during selection
  const renderTempArc = () => {
    if (!selectedSource || !hoveredToken || selectedSource.lemmaSpanId === hoveredToken.lemmaSpanId) {
      return null;
    }
    
    const isToRoot = hoveredToken.lemmaSpanId === 'ROOT';
    const targetPos = isToRoot ? { x: selectedSource.x, y: ROOT_Y, index: -1 } : hoveredToken;
    const pathData = computeEdge(selectedSource, targetPos, isToRoot);
    
    return (
      <path
        d={pathData}
        className="tree-temp-arc"
      />
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
      const sourcePos = tokenPositions.find(p => p.lemmaSpanId === dragSourceId);
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

  const minSvgWidth = PADDING * 2 + tokens.length * TOKEN_SPACING;

  return (
    <div className="dependency-tree-container">
      {/* Instructions */}
      {relations.length === 0 && (
        <div className="tree-instruction-box">
          Click on a token to select it as the source, then click on another token or the ROOT bar to create a dependency relation. Alternatively, drag from a source token to a target token.
        </div>
      )}
      
      {selectedSource && (
        <div className="tree-source-selected-box">
          Source selected: "{selectedSource.form}". Click on a target token or ROOT to create a relation. Press Escape to cancel.
        </div>
      )}
      
      <svg
        ref={svgRef}
        width="100%"
        height={TREE_HEIGHT}
        className="tree-svg"
        style={{ minWidth: `${minSvgWidth}px` }}
        onMouseMove={handleSvgMouseMove}
        onMouseUp={handleSvgMouseUp}
      >
        {/* ROOT bar - extends from top to ROOT_Y */}
        <rect
          x={0}
          y={0}
          width="100%"
          height={ROOT_Y + 5}
          fill={hoveredToken?.lemmaSpanId === 'ROOT' ? '#e5e7eb' : '#fafafa'}
          className={selectedSource || dragOrigin ? 'tree-root-rect' : 'tree-root-rect--default'}
          onClick={() => handleRootClick()}
          onMouseDown={handleRootMouseDown}
          onMouseUp={handleRootMouseUp}
          onMouseEnter={() => setHoveredToken({ lemmaSpanId: 'ROOT' })}
          onMouseLeave={() => setHoveredToken(null)}
        />
        
        {/* Render existing relations */}
        {relations.map((relation, index) => renderArc(relation, index))}
        
        {/* Render temporary arc */}
        {renderTempArc()}
        
        {/* Render drag arc */}
        {renderDragArc()}
        
        {/* Render token texts */}
        {tokenPositions.map((position) => {
          const isSource = selectedSource?.lemmaSpanId === position.lemmaSpanId;
          const isHovered = hoveredToken?.lemmaSpanId === position.lemmaSpanId;
          const isDragSource = dragSourceId === position.lemmaSpanId;
          
          return (
            <g
              key={position.token.id}
              className={`tree-token-group ${dragOrigin ? 'tree-token-group--drag' : 'tree-token-group--grab'}`}
              onClick={() => handleTokenClick(position)}
              onMouseDown={(e) => handleTokenMouseDown(e, position)}
              onMouseUp={(e) => handleTokenMouseUp(e, position)}
              onMouseEnter={() => setHoveredToken(position)}
              onMouseLeave={() => setHoveredToken(null)}
            >
              <text
                x={position.x}
                y={position.y}
                className={`tree-token-text ${
                  isDragSource ? 'tree-token-text--drag-source' : 
                  isSource ? 'tree-token-text--selected' : 
                  isHovered ? 'tree-token-text--hovered' : 
                  'tree-token-text--normal'
                }`}
              >
                {position.form}
              </text>
              {/* Token index below */}
              <text
                x={position.x}
                y={position.y + 15}
                className="tree-token-index"
              >
                {position.index + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};