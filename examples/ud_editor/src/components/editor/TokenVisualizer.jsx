import { useState, useRef, useEffect } from 'react';

export const TokenVisualizer = ({ text, originalText, tokens, sentenceSpans = [], mwtSpans = [], onTokenUpdate, onTokenDelete, onTokenCreate, onSentenceToggle, onMwtCreate, onMwtDelete }) => {
  const [hoveredToken, setHoveredToken] = useState(null);
  const [editingToken, setEditingToken] = useState(null);
  const [editBegin, setEditBegin] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const hoverTimeoutRef = useRef(null);
  const closeTimeoutRef = useRef(null);
  const textContainerRef = useRef(null);

  // MWT drag state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartToken, setDragStartToken] = useState(null);
  const [dragOverTokens, setDragOverTokens] = useState(new Set());
  const [suppressTextSelection, setSuppressTextSelection] = useState(false);

  // Check if text is dirty (different from what was tokenized)
  const isTextDirty = originalText && text !== originalText;

  // Handle keyboard shortcuts for token adjustment
  const handleKeyDown = async (event) => {
    // Only process keys when a token is hovered and not editing
    if (!hoveredToken || editingToken || isTextDirty) return;

    const { key } = event;
    let newBegin = hoveredToken.begin;
    let newEnd = hoveredToken.end;

    switch (key) {
      case 's': // subtract 1 from token's begin
        newBegin = hoveredToken.begin - 1;
        break;
      case 'S': // add 1 to token's begin
        newBegin = hoveredToken.begin + 1;
        break;
      case 'd': // add 1 to token's end
        newEnd = hoveredToken.end + 1;
        break;
      case 'D': // subtract 1 from token's end
        newEnd = hoveredToken.end - 1;
        break;
      default:
        return; // Not a key we handle
    }

    // Validate the new bounds
    if (newBegin < 0 || newEnd > text.length || newBegin > newEnd) {
      return; // Invalid bounds, do nothing
    }

    // If bounds are valid and different, update the token
    if (newBegin !== hoveredToken.begin || newEnd !== hoveredToken.end) {
      event.preventDefault(); // Prevent default behavior
      try {
        await onTokenUpdate(hoveredToken.id, newBegin, newEnd);
        // Update the hovered token state to reflect the change
        setHoveredToken({
          ...hoveredToken,
          begin: newBegin,
          end: newEnd
        });
      } catch (error) {
        console.error('Token update failed:', error);
      }
    }
  };

  // Add keyboard event listener
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [hoveredToken, editingToken, isTextDirty, text, onTokenUpdate]);

  const handleTokenMouseEnter = (token) => {
    // Don't show tooltip if text is dirty
    if (isTextDirty) return;
    
    // Clear any existing timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    
    // Set new timeout for 400ms delay
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredToken(token);
    }, 400);
  };

  const handleTokenMouseLeave = () => {
    // Clear the show timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    
    // Start close timeout - give user time to move to tooltip
    closeTimeoutRef.current = setTimeout(() => {
      setHoveredToken(null);
    }, 300);
  };

  const handleTooltipMouseEnter = () => {
    // Cancel close timeout when mouse enters tooltip
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
    }
  };

  const handleTooltipMouseLeave = () => {
    // Close tooltip when mouse leaves tooltip area
    setHoveredToken(null);
  };

  const handleEditClick = (token) => {
    setEditingToken(token);
    setEditBegin(token.begin.toString());
    setEditEnd(token.end.toString());
    setHoveredToken(null);
    
    // Clear any pending timeouts
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
    }
  };

  const handleDeleteClick = async (token) => {
    try {
      await onTokenDelete(token.id);
      // Clear hover state after successful deletion
      setHoveredToken(null);
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    } catch (error) {
      console.error('Token deletion failed:', error);
      // Hover menu will stay open on error
    }
  };

  const handleEditCancel = () => {
    setEditingToken(null);
    setEditBegin('');
    setEditEnd('');
    
    // Ensure hover state is fully cleared
    setHoveredToken(null);
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
    }
  };

  const validateAndSave = async () => {
    const newBegin = parseInt(editBegin);
    const newEnd = parseInt(editEnd);

    // Validation
    if (isNaN(newBegin) || isNaN(newEnd)) {
      return; // Invalid numbers
    }
    
    if (newBegin < 0) {
      return; // Begin cannot be negative
    }
    
    if (newEnd > text.length) {
      return; // End cannot exceed text length
    }
    
    if (newEnd - newBegin < 0) {
      return; // End cannot be before begin
    }

    // Call the update function
    try {
      await onTokenUpdate(editingToken.id, newBegin, newEnd);
      // Success - close editor and fully clear all hover states
      setEditingToken(null);
      setEditBegin('');
      setEditEnd('');
      setHoveredToken(null);
      
      // Clear all timeouts to prevent any lingering hover behavior
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    } catch (error) {
      // Error - the parent should handle refresh
      console.error('Token update failed:', error);
      handleEditCancel();
    }
  };

  // MWT drag handlers
  const handleTokenMouseDown = (token, event) => {
    // Only allow MWT creation when text is not dirty
    if (isTextDirty) return;
    
    // Only start drag on left mouse button
    if (event.button !== 0) return;
    
    console.log('Starting MWT drag on token:', token.id);
    setIsDragging(true);
    setDragStartToken(token);
    setDragOverTokens(new Set([token.id]));
    setSuppressTextSelection(true);
    
    // Prevent text selection during drag
    event.preventDefault();
    event.stopPropagation();
    
    // Also prevent selection at the document level
    document.onselectstart = () => false;
    document.ondragstart = () => false;
  };

  const handleTokenMouseEnterDrag = (token) => {
    if (!isDragging || !dragStartToken) return;
    
    // Find all tokens between start token and current token
    const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);
    const startIndex = sortedTokens.findIndex(t => t.id === dragStartToken.id);
    const currentIndex = sortedTokens.findIndex(t => t.id === token.id);
    
    if (startIndex === -1 || currentIndex === -1) return;
    
    const minIndex = Math.min(startIndex, currentIndex);
    const maxIndex = Math.max(startIndex, currentIndex);
    
    // Check if tokens are contiguous (no intervening tokens)
    const tokensInRange = sortedTokens.slice(minIndex, maxIndex + 1);
    
    let isContiguous = true;
    for (let i = 1; i < tokensInRange.length; i++) {
      const tokenA = tokensInRange[i-1];
      const tokenB = tokensInRange[i];
      
      // Check if any other token exists between tokenA and tokenB
      const hasInterveningToken = sortedTokens.some(t => {
        // Skip tokens that are part of our range
        if (tokensInRange.includes(t)) return false;
        
        // Check if this token starts after tokenA ends and before tokenB begins
        return t.begin >= tokenA.end && t.begin < tokenB.begin;
      });
      
      if (hasInterveningToken) {
        isContiguous = false;
        break;
      }
    }
    
    if (isContiguous) {
      const draggedTokenIds = new Set(tokensInRange.map(t => t.id));
      setDragOverTokens(draggedTokenIds);
    }
  };

  const handleMouseUp = () => {
    if (!isDragging) return;
    
    setIsDragging(false);
    
    // Restore normal selection behavior
    document.onselectstart = null;
    document.ondragstart = null;
    
    // Clear any text selection that might have occurred during drag
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
    }
    
    // If we have multiple tokens selected, create MWT directly
    if (dragOverTokens.size >= 2) {
      const sortedTokens = [...tokens].sort((a, b) => a.begin - b.begin);
      const selectedTokensList = sortedTokens.filter(t => dragOverTokens.has(t.id));
      const tokenIds = selectedTokensList.map(t => t.id);
      
      // Create MWT with null value
      if (onMwtCreate) {
        onMwtCreate(tokenIds, null);
      }
    }
    
    // Reset drag state
    setDragStartToken(null);
    setDragOverTokens(new Set());
    
    // Re-enable text selection after a short delay to avoid immediate triggering
    setTimeout(() => {
      setSuppressTextSelection(false);
    }, 100);
  };


  // Add global mouse up listener for drag operations
  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      // Clean up selection prevention if component unmounts during drag
      document.onselectstart = null;
      document.ondragstart = null;
    };
  }, [isDragging, dragOverTokens, tokens, onMwtCreate]);

  const handleTextSelection = () => {
    // Don't create tokens if we're in the middle of MWT drag operations
    if (isDragging || suppressTextSelection) return;
    
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!range || range.collapsed) return; // No selection or cursor only

    // Check if selection is within our text container
    const container = textContainerRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) return;

    // Get the selected text directly
    const selectedText = range.toString();
    if (!selectedText || selectedText.length === 0) return;

    console.log('Selected text:', JSON.stringify(selectedText));

    // We need to walk through the DOM and build a mapping between DOM positions and text positions
    // This accounts for badges and other DOM elements
    const textPositionMap = [];
    let textPosition = 0;
    
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // Skip text nodes that are inside badge spans
          const parent = node.parentElement;
          if (parent && parent.classList.contains('absolute')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );

    let node;
    while (node = walker.nextNode()) {
      const nodeText = node.textContent;
      for (let i = 0; i < nodeText.length; i++) {
        textPositionMap.push({
          node: node,
          nodeOffset: i,
          textPosition: textPosition
        });
        textPosition++;
      }
    }

    console.log('Text position map length:', textPositionMap.length, 'Original text length:', text.length);

    // Find the start and end positions in our text position map
    let selectionStart = -1;
    let selectionEnd = -1;

    for (let i = 0; i < textPositionMap.length; i++) {
      const mapping = textPositionMap[i];
      if (mapping.node === range.startContainer && mapping.nodeOffset === range.startOffset) {
        selectionStart = mapping.textPosition;
      }
      if (mapping.node === range.endContainer && mapping.nodeOffset === range.endOffset) {
        selectionEnd = mapping.textPosition;
        break;
      }
    }

    // Special case: if selection ends at the very end of text, endContainer might be the container itself
    if (selectionEnd === -1 && range.endContainer === container) {
      console.log('Selection ends at container, using text length');
      selectionEnd = text.length;
    }

    // Another special case: if endContainer is a text node but we're at the end of it
    if (selectionEnd === -1 && range.endContainer.nodeType === Node.TEXT_NODE) {
      const endNode = range.endContainer;
      const endOffset = range.endOffset;
      
      // Find this text node in our mapping and calculate position
      for (let i = 0; i < textPositionMap.length; i++) {
        const mapping = textPositionMap[i];
        if (mapping.node === endNode && mapping.nodeOffset === endOffset - 1) {
          selectionEnd = mapping.textPosition + 1;
          break;
        }
      }
    }

    console.log('Calculated positions:', { selectionStart, selectionEnd });

    if (selectionStart === -1 || selectionEnd === -1 || selectionStart >= selectionEnd) {
      console.log('Invalid selection positions');
      return;
    }

    // Verify the selection matches what we expect
    const calculatedText = text.slice(selectionStart, selectionEnd);
    console.log('Calculated text:', JSON.stringify(calculatedText));
    
    if (calculatedText !== selectedText) {
      console.log('Text mismatch, falling back to first occurrence');
      // Fallback to first occurrence if calculation is wrong
      const index = text.indexOf(selectedText);
      if (index === -1) return;
      selectionStart = index;
      selectionEnd = index + selectedText.length;
    }

    // Check if selection overlaps with existing tokens
    const overlapsWithToken = tokens.some(token => 
      selectionStart < token.end && selectionEnd > token.begin
    );

    if (overlapsWithToken) {
      alert('Cannot create token: selection overlaps with existing tokens');
      return;
    }

    console.log('Final selection positions:', { selectionStart, selectionEnd, selectedText: text.slice(selectionStart, selectionEnd) });

    // Create new token
    if (onTokenCreate) {
      onTokenCreate(selectionStart, selectionEnd);
    }

    // Clear selection
    selection.removeAllRanges();
  };

  if (!text) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p>No text to visualize</p>
      </div>
    );
  }

  if (tokens.length === 0) {
    return (
      <div>
        <div 
          ref={textContainerRef}
          className="p-4 bg-white rounded border border-gray-200 font-mono text-sm whitespace-pre-wrap select-text"
          onMouseUp={handleTextSelection}
        >
          {text}
        </div>
        <p className="mt-4 text-sm text-gray-500 text-center">No tokens yet. Click "Whitespace Tokenize" to create tokens, or select text to create individual tokens.</p>
      </div>
    );
  }

  // Adjust token positions if text has changed since tokenization
  const adjustTokenPositions = (tokens, originalText, currentText) => {
    if (!originalText || originalText === currentText) {
      return tokens; // No adjustment needed
    }

    // Calculate the difference between original and current text
    // This helps us understand what kind of edit was made
    const findEditPosition = (original, current) => {
      let i = 0;
      // Find first difference from the start
      while (i < Math.min(original.length, current.length) && original[i] === current[i]) {
        i++;
      }
      return i;
    };

    const editPos = findEditPosition(originalText, currentText);
    const lengthDiff = currentText.length - originalText.length;
    
    return tokens.map(token => {
      const originalTokenText = originalText.slice(token.begin, token.end);
      
      // If token is completely before the edit position, it's unaffected
      if (token.end <= editPos) {
        return token;
      }
      
      // If token starts after the edit position, shift it by the length difference
      if (token.begin >= editPos) {
        const newBegin = token.begin + lengthDiff;
        const newEnd = token.end + lengthDiff;
        
        // Validate the new positions
        if (newBegin >= 0 && newEnd <= currentText.length) {
          const newTokenText = currentText.slice(newBegin, newEnd);
          if (newTokenText === originalTokenText) {
            return {
              ...token,
              begin: newBegin,
              end: newEnd,
              adjusted: true
            };
          }
        }
      }
      
      // Token overlaps with edit - try to find it in the current text
      let bestMatch = null;
      let bestScore = 0;
      
      // Look for exact matches first
      let searchStart = 0;
      while (true) {
        const index = currentText.indexOf(originalTokenText, searchStart);
        if (index === -1) break;
        
        // Prefer matches that are close to the original position
        const distance = Math.abs(index - token.begin);
        const score = 1000 - distance; // Higher score for closer matches
        
        if (score > bestScore) {
          bestScore = score;
          bestMatch = {
            begin: index,
            end: index + originalTokenText.length
          };
        }
        
        searchStart = index + 1;
      }
      
      if (bestMatch) {
        return {
          ...token,
          begin: bestMatch.begin,
          end: bestMatch.end,
          adjusted: true
        };
      }
      
      // Try partial matches (prefixes and suffixes)
      for (let len = Math.max(2, Math.floor(originalTokenText.length * 0.6)); len >= 2; len--) {
        // Try suffix
        if (len < originalTokenText.length) {
          const suffix = originalTokenText.slice(-len);
          const suffixIndex = currentText.indexOf(suffix);
          if (suffixIndex !== -1) {
            return {
              ...token,
              begin: suffixIndex,
              end: suffixIndex + suffix.length,
              adjusted: true
            };
          }
        }
        
        // Try prefix
        if (len < originalTokenText.length) {
          const prefix = originalTokenText.slice(0, len);
          const prefixIndex = currentText.indexOf(prefix);
          if (prefixIndex !== -1) {
            return {
              ...token,
              begin: prefixIndex,
              end: prefixIndex + prefix.length,
              adjusted: true
            };
          }
        }
      }
      
      // Token not found - mark as invalid
      return {
        ...token,
        invalid: true,
        originalText: originalTokenText
      };
    });
  };

  const adjustedTokens = adjustTokenPositions(tokens, originalText, text);
  
  // Sort tokens by begin position, putting invalid tokens at the end
  const sortedTokens = [...adjustedTokens].sort((a, b) => {
    if (a.invalid && !b.invalid) return 1;
    if (!a.invalid && b.invalid) return -1;
    return a.begin - b.begin;
  });

  // Build visualization with highlighted tokens
  const renderTokenizedText = () => {
    // Create a set of token IDs that start sentences
    // The spans have a 'tokens' array, not 'begin' and 'end' properties
    const sentenceStartTokenIds = new Set(
      sentenceSpans.map(span => {
        // Check if span has tokens array
        if (span.tokens && span.tokens.length > 0) {
          return span.tokens[0]; // First token in the span
        }
        // Fallback to begin property if it exists
        return span.begin;
      }).filter(id => id != null)
    );

    // Create a map of token ID to MWT info
    const tokenToMwt = new Map();
    mwtSpans.forEach(mwtSpan => {
      if (mwtSpan.tokens && mwtSpan.tokens.length > 0) {
        mwtSpan.tokens.forEach(tokenId => {
          tokenToMwt.set(tokenId, {
            surfaceForm: mwtSpan.value,
            spanId: mwtSpan.id,
            allTokens: mwtSpan.tokens
          });
        });
      }
    });

    // Group tokens by sentences
    const sentences = [];
    let currentSentence = [];
    let sentenceNumber = 0;

    sortedTokens.forEach((token) => {
      if (token.invalid) return;

      if (sentenceStartTokenIds.has(token.id) && currentSentence.length > 0) {
        // Start of new sentence, save current and start new
        sentences.push({
          tokens: currentSentence,
          number: sentenceNumber
        });
        currentSentence = [];
        sentenceNumber++;
      }
      
      currentSentence.push(token);
    });

    // Add the last sentence
    if (currentSentence.length > 0) {
      sentences.push({
        tokens: currentSentence,
        number: sentenceNumber
      });
    }

    // If no sentences defined, treat all tokens as one sentence
    if (sentences.length === 0 && sortedTokens.filter(t => !t.invalid).length > 0) {
      sentences.push({
        tokens: sortedTokens.filter(t => !t.invalid),
        number: 0
      });
    }

    // Render sentences
    return sentences.map((sentence, sentenceIdx) => {
      const sentenceElements = [];
      let lastEnd = sentenceIdx === 0 ? 0 : sentences[sentenceIdx - 1].tokens[sentences[sentenceIdx - 1].tokens.length - 1].end;

      // Group tokens by MWT or individual tokens
      const tokenGroups = [];
      let currentGroup = null;
      
      sentence.tokens.forEach((token, tokenIdx) => {
        const mwtInfo = tokenToMwt.get(token.id);
        
        if (mwtInfo) {
          // Check if this is the start of a new MWT or continuation of current MWT
          if (!currentGroup || currentGroup.type !== 'mwt' || currentGroup.spanId !== mwtInfo.spanId) {
            // Start new MWT group
            currentGroup = {
              type: 'mwt',
              spanId: mwtInfo.spanId,
              tokens: [token],
              startIndex: tokenIdx
            };
            tokenGroups.push(currentGroup);
          } else {
            // Continue current MWT group
            currentGroup.tokens.push(token);
          }
        } else {
          // Individual token
          tokenGroups.push({
            type: 'individual',
            tokens: [token],
            startIndex: tokenIdx
          });
          currentGroup = null;
        }
      });

      // Render token groups
      tokenGroups.forEach((group, groupIdx) => {
        // Handle text before the first token in this group
        const firstToken = group.tokens[0];
        if (firstToken.begin > lastEnd) {
          const betweenText = text.slice(lastEnd, firstToken.begin);
          sentenceElements.push(
            <span key={`between-${sentenceIdx}-${groupIdx}`} className="text-gray-400">
              {betweenText}
            </span>
          );
        }

        if (group.type === 'mwt') {
          // Render MWT group with rectangle
          const mwtTokenElements = group.tokens.map((token, tokenIdx) => {
            const tokenText = text.slice(token.begin, token.end);
            const isZeroWidth = token.begin === token.end;
            const displayText = isZeroWidth ? '∅' : tokenText;
            const isStartOfSentence = sentenceStartTokenIds.has(token.id);
            const isFirstToken = tokenIdx === 0;
            const isLastToken = tokenIdx === group.tokens.length - 1;
            
            return (
              <span 
                key={`token-${token.id}`}
                className={`relative inline-block px-1 py-0.5 border bg-orange-100 border-orange-400 hover:bg-orange-200 cursor-pointer transition-colors whitespace-pre ${
                  isStartOfSentence ? 'border-green-500 border-2' : ''
                } ${
                  dragOverTokens.has(token.id) ? 'bg-yellow-200 border-yellow-400' : ''
                } ${
                  isFirstToken ? 'rounded-l -mr-px' : isLastToken ? 'rounded-r -ml-px' : '-mx-px'
                }`}
                onMouseEnter={(e) => {
                  handleTokenMouseEnter(token);
                  handleTokenMouseEnterDrag(token);
                }}
                onMouseLeave={handleTokenMouseLeave}
                onMouseDown={(e) => handleTokenMouseDown(token, e)}
                onClick={async () => {
                  if (isTextDirty || isDragging) return;
                  if (onSentenceToggle) {
                    try {
                      await onSentenceToggle(token.id, !isStartOfSentence);
                      setHoveredToken(null);
                      if (hoverTimeoutRef.current) {
                        clearTimeout(hoverTimeoutRef.current);
                      }
                      if (closeTimeoutRef.current) {
                        clearTimeout(closeTimeoutRef.current);
                      }
                    } catch (error) {
                      console.error('Failed to toggle sentence marker:', error);
                    }
                  }
                }}
              >
                {displayText}
                
                {/* Token tooltip and edit modal */}
                {hoveredToken && hoveredToken.id === token.id && !editingToken && (
                  <div 
                    className="absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-gray-800 text-white text-sm px-3 py-2 rounded shadow-lg whitespace-nowrap min-w-48"
                    onMouseEnter={handleTooltipMouseEnter}
                    onMouseLeave={handleTooltipMouseLeave}
                  >
                    <div className="mb-2">
                      <div className="font-semibold">Token {token.id}</div>
                      <div className="text-gray-300">Range: [{token.begin}-{token.end}]</div>
                      <div className="text-gray-300">Text: "{tokenText}"</div>
                      <div className="text-orange-300 mt-1">Part of MWT</div>
                    </div>
                    
                    {onSentenceToggle && (
                      <div className="mb-2 pb-2 border-b border-gray-600">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isStartOfSentence}
                            onChange={async (e) => {
                              try {
                                await onSentenceToggle(token.id, e.target.checked);
                                setHoveredToken(null);
                                if (hoverTimeoutRef.current) {
                                  clearTimeout(hoverTimeoutRef.current);
                                }
                                if (closeTimeoutRef.current) {
                                  clearTimeout(closeTimeoutRef.current);
                                }
                              } catch (error) {
                                console.error('Failed to toggle sentence marker:', error);
                              }
                            }}
                            className="rounded border-gray-400 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-gray-300 text-xs">Start of sentence</span>
                        </label>
                      </div>
                    )}
                    
                    <div className="flex gap-2">
                      <button 
                        onClick={() => handleEditClick(token)}
                        className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded transition-colors"
                      >
                        Edit Range
                      </button>
                      <button 
                        onClick={() => handleDeleteClick(token)}
                        className="flex-1 bg-red-600 hover:bg-red-700 text-white text-xs px-2 py-1 rounded transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}

                {editingToken && editingToken.id === token.id && (
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-white border border-gray-300 shadow-lg rounded-lg p-4 min-w-64">
                    <div className="mb-3">
                      <div className="font-semibold text-gray-900 mb-1">Edit Token Range</div>
                      <div className="text-sm text-gray-600">Token: "{text.slice(editingToken.begin, editingToken.end)}"</div>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Begin</label>
                        <input
                          type="number"
                          value={editBegin}
                          onChange={(e) => setEditBegin(e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                          min="0"
                          max={text.length}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">End</label>
                        <input
                          type="number"
                          value={editEnd}
                          onChange={(e) => setEditEnd(e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                          min="1"
                          max={text.length}
                        />
                      </div>
                    </div>
                    
                    <div className="flex gap-2">
                      <button
                        onClick={validateAndSave}
                        className="flex-1 bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1 rounded transition-colors"
                      >
                        Save
                      </button>
                      <button
                        onClick={handleEditCancel}
                        className="flex-1 bg-gray-600 hover:bg-gray-700 text-white text-xs px-3 py-1 rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </span>
            );
          });

          // Add MWT group with rectangle
          sentenceElements.push(
            <span key={`mwt-group-${sentenceIdx}-${groupIdx}`} className="relative inline-block ml-0.5 mr-0.5">
              {mwtTokenElements}
              <div
                className="absolute bottom-0 left-0 right-0 h-1 bg-orange-500 hover:bg-orange-600 transition-colors rounded"
                style={{ bottom: '-2px', zIndex: 20, height: '4px', cursor: 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><polyline points=\'3,6 5,6 21,6\'></polyline><path d=\'m19,6v14a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2,2 0 0,1 2,2v2\'></path><line x1=\'10\' y1=\'11\' x2=\'10\' y2=\'17\'></line><line x1=\'14\' y1=\'11\' x2=\'14\' y2=\'17\'></line></svg>") 12 12, pointer' }}
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (onMwtDelete) {
                    try {
                      await onMwtDelete(group.spanId);
                    } catch (error) {
                      console.error('Failed to delete MWT:', error);
                    }
                  }
                }}
                title="Click to delete MWT"
              />
            </span>
          );
        } else {
          // Render individual token
          const token = group.tokens[0];
          const tokenText = text.slice(token.begin, token.end);
          const isZeroWidth = token.begin === token.end;
          const displayText = isZeroWidth ? '∅' : tokenText;
          const isStartOfSentence = sentenceStartTokenIds.has(token.id);
          
          sentenceElements.push(
            <span 
              key={`token-${token.id}`}
              className={`relative inline-block px-1 py-0.5 border bg-blue-100 border-blue-300 hover:bg-blue-200 rounded mx-0.5 cursor-pointer transition-colors whitespace-pre ${
                isStartOfSentence ? 'border-green-500 border-2' : ''
              } ${
                dragOverTokens.has(token.id) ? 'bg-yellow-200 border-yellow-400' : ''
              }`}
              onMouseEnter={(e) => {
                handleTokenMouseEnter(token);
                handleTokenMouseEnterDrag(token);
              }}
              onMouseLeave={handleTokenMouseLeave}
              onMouseDown={(e) => handleTokenMouseDown(token, e)}
              onClick={async () => {
                // Don't do anything if text is dirty or if we're dragging
                if (isTextDirty || isDragging) return;
                
                // Toggle sentence marking
                if (onSentenceToggle) {
                  try {
                    await onSentenceToggle(token.id, !isStartOfSentence);
                    // Clear hover state after click
                    setHoveredToken(null);
                    if (hoverTimeoutRef.current) {
                      clearTimeout(hoverTimeoutRef.current);
                    }
                    if (closeTimeoutRef.current) {
                      clearTimeout(closeTimeoutRef.current);
                    }
                  } catch (error) {
                    console.error('Failed to toggle sentence marker:', error);
                  }
                }
              }}
            >
              {displayText}

              {/* Tooltip */}
              {hoveredToken && hoveredToken.id === token.id && !editingToken && (
                <div 
                  className="absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-gray-800 text-white text-sm px-3 py-2 rounded shadow-lg whitespace-nowrap min-w-48"
                  onMouseEnter={handleTooltipMouseEnter}
                  onMouseLeave={handleTooltipMouseLeave}
                >
                  <div className="mb-2">
                    <div className="font-semibold">Token {token.id}</div>
                    <div className="text-gray-300">Range: [{token.begin}-{token.end}]</div>
                    <div className="text-gray-300">Text: "{tokenText}"</div>
                  </div>
                  
                  {/* Sentence marking toggle */}
                  {onSentenceToggle && (
                    <div className="mb-2 pb-2 border-b border-gray-600">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isStartOfSentence}
                          onChange={async (e) => {
                            try {
                              await onSentenceToggle(token.id, e.target.checked);
                              // Close the tooltip after successful toggle
                              setHoveredToken(null);
                              // Clear any pending timeouts
                              if (hoverTimeoutRef.current) {
                                clearTimeout(hoverTimeoutRef.current);
                              }
                              if (closeTimeoutRef.current) {
                                clearTimeout(closeTimeoutRef.current);
                              }
                            } catch (error) {
                              console.error('Failed to toggle sentence marker:', error);
                            }
                          }}
                          className="rounded border-gray-400 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-gray-300 text-xs">Start of sentence</span>
                      </label>
                    </div>
                  )}
                  
                  <div className="flex gap-2">
                    <button 
                      onClick={() => handleEditClick(token)}
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded transition-colors"
                    >
                      Edit Range
                    </button>
                    <button 
                      onClick={() => handleDeleteClick(token)}
                      className="flex-1 bg-red-600 hover:bg-red-700 text-white text-xs px-2 py-1 rounded transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}

              {/* Edit Modal */}
              {editingToken && editingToken.id === token.id && (
                <div className="absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-white border border-gray-300 shadow-lg rounded-lg p-4 min-w-64">
                  <div className="mb-3">
                    <div className="font-semibold text-gray-900 mb-1">Edit Token Range</div>
                    <div className="text-sm text-gray-600">Token: "{text.slice(editingToken.begin, editingToken.end)}"</div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Begin</label>
                      <input
                        type="number"
                        value={editBegin}
                        onChange={(e) => setEditBegin(e.target.value)}
                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                        min="0"
                        max={text.length}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">End</label>
                      <input
                        type="number"
                        value={editEnd}
                        onChange={(e) => setEditEnd(e.target.value)}
                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                        min="1"
                        max={text.length}
                      />
                    </div>
                  </div>
                  
                  <div className="flex gap-2">
                    <button
                      onClick={validateAndSave}
                      className="flex-1 bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1 rounded transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={handleEditCancel}
                      className="flex-1 bg-gray-600 hover:bg-gray-700 text-white text-xs px-3 py-1 rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </span>
          );
        }

        lastEnd = group.tokens[group.tokens.length - 1].end;
      });

      // Add any remaining text after the last token in this sentence
      // Only if this is the last sentence
      if (sentenceIdx === sentences.length - 1 && lastEnd < text.length) {
        const remainingText = text.slice(lastEnd);
        sentenceElements.push(
          <span key={`remaining-${sentenceIdx}`} className="text-gray-400">
            {remainingText}
          </span>
        );
      }

      return (
        <div key={`sentence-${sentenceIdx}`} className="mb-2 relative">
          {sentenceElements}
        </div>
      );
    });
  };

  return (
    <div>
      <div 
        ref={textContainerRef}
        className="p-4 bg-white rounded border border-gray-200 font-mono text-sm leading-relaxed select-text"
        onMouseUp={(e) => {
          // Only handle text selection if we're not doing MWT operations
          if (!isDragging && !suppressTextSelection) {
            handleTextSelection();
          }
        }}
      >
        {renderTokenizedText()}
      </div>
    </div>
  );
};