import { useState, useCallback } from 'react';
import { notifications } from '@mantine/notifications';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler';
import documentsStore from '../../../stores/documentsStore.js';

export const useAlignmentEditor = (selection, parsedDocument, project, projectId, documentId, client, onAlignmentCreated) => {
  const handleStrictModeError = useStrictModeErrorHandler(onAlignmentCreated);
  const [isProcessing, setIsProcessing] = useState(false);

  // Get the proper document proxy for mutations
  const getDocProxy = () => documentsStore[projectId][documentId];

  // Find existing alignment token that matches current selection
  const getExistingAlignment = useCallback(() => {
    const docProxy = getDocProxy();
    return docProxy?.alignmentTokens?.find(token => 
      token.metadata?.timeBegin === selection?.start && 
      token.metadata?.timeEnd === selection?.end
    );
  }, [selection, projectId, documentId]);

  // Find available text boundaries for alignment
  const getAvailableTextBoundaries = useCallback(() => {
    const alignmentTokens = parsedDocument?.alignmentTokens || [];
    const sortedTokens = [...alignmentTokens].sort((a, b) => 
      (a.metadata?.timeBegin || 0) - (b.metadata?.timeBegin || 0)
    );
    
    const textLength = parsedDocument?.document?.text?.body?.length || 0;
    
    // Find constraints from neighboring alignment tokens
    let leftBoundary = 0;
    let rightBoundary = textLength;
    
    for (const token of sortedTokens) {
      const tokenTimeBegin = token.metadata?.timeBegin || 0;
      const tokenTimeEnd = token.metadata?.timeEnd || 0;
      
      if (tokenTimeEnd <= selection.start && token.end > leftBoundary) {
        leftBoundary = token.end;
      }
      if (tokenTimeBegin >= selection.end && token.begin < rightBoundary) {
        rightBoundary = token.begin;
      }
    }
    
    return { leftBoundary, rightBoundary };
  }, [parsedDocument, selection]);

  // Get available text for alignment
  const getAvailableText = useCallback(() => {
    const { leftBoundary, rightBoundary } = getAvailableTextBoundaries();
    const fullText = parsedDocument?.document?.text?.body || '';
    return fullText.substring(leftBoundary, rightBoundary);
  }, [getAvailableTextBoundaries, parsedDocument]);

  // Check if baseline text is available for alignment
  const canAlign = useCallback(() => {
    const availableText = getAvailableText();
    return availableText.trim().length > 0;
  }, [getAvailableText]);

  // Create new alignment
  const createAlignment = useCallback(async (text) => {
    if (!text.trim() || isProcessing) return;
    
    setIsProcessing(true);
    try {
      // Get necessary layer IDs
      const primaryTextLayer = parsedDocument?.layers?.primaryTextLayer;
      const alignmentTokenLayer = parsedDocument?.layers?.alignmentTokenLayer;
      const sentenceTokenLayer = parsedDocument?.layers?.sentenceTokenLayer;

      if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
        throw new Error('Required layers not found');
      }

      // Get existing text ID from parsed document
      let textId = parsedDocument?.layers?.primaryTextLayer?.text?.id;

      // Get existing text and alignment tokens to determine insertion point
      const existingText = parsedDocument?.document?.text?.body || '';
      const alignmentTokens = parsedDocument?.alignmentTokens || [];

      // Sort alignment tokens by time
      const sortedTokens = [...alignmentTokens].sort((a, b) =>
          (a.metadata?.timeBegin || 0) - (b.metadata?.timeBegin || 0)
      );

      // Find where to insert based on time while maintaining temporal ordering
      let insertPosition = existingText.length;
      let insertAfterToken = null;
      let insertBeforeToken = null;

      // Find the tokens that temporally bracket our selection
      for (let i = 0; i < sortedTokens.length; i++) {
        const token = sortedTokens[i];
        const tokenTime = token.metadata?.timeBegin || 0;
        
        if (tokenTime <= selection.start) {
          insertAfterToken = token;
        } else if (tokenTime > selection.start && !insertBeforeToken) {
          insertBeforeToken = token;
          break;
        }
      }

      // Determine insertion position
      if (!insertAfterToken && !insertBeforeToken) {
        // No existing tokens, insert at end
        insertPosition = existingText.length;
      } else if (!insertAfterToken && insertBeforeToken) {
        // Insert before first token temporally
        insertPosition = 0;
      } else if (insertAfterToken && !insertBeforeToken) {
        // Insert after last token temporally
        insertPosition = insertAfterToken.end;
      } else if (insertAfterToken && insertBeforeToken) {
        // We have tokens on both sides temporally
        // Check if there's a positional conflict (temporal ordering violation)
        if (insertBeforeToken.begin < insertAfterToken.end) {
          // Tokens are out of order positionally - insert before the "before" token
          console.warn('Detected temporal ordering violation, inserting before conflicting token');
          insertPosition = insertBeforeToken.begin;
        } else {
          // Normal case - insert after the "after" token
          insertPosition = insertAfterToken.end;
        }
      }

      // Insert text with proper spacing
      let insertedText;
      let insertBegin, insertEnd;
      let tokenBegin, tokenEnd;
      let sentenceTokenEnd; // Track sentence token end including trailing space
      let sentenceTokenBegin; // Track sentence token start to ensure complete partitioning
      
      // Insert at the front
      if (insertPosition === 0) {
        const spaceAfter = (existingText ? ' ' : '')
        insertedText = text.trim() + spaceAfter;

        tokenBegin = 0;
        insertBegin = 0;
        tokenEnd = text.trim().length
        insertEnd = tokenEnd + (existingText ? 1 : 0);
        sentenceTokenEnd = tokenEnd + (existingText ? 1 : 0); // Include trailing space
        sentenceTokenBegin = 0; // Start from beginning
      }
      // Insert at end
      else if (insertPosition >= existingText.length) {
        const spaceBefore = existingText ? ' ' : '';
        insertedText = spaceBefore + text.trim();

        insertBegin = existingText.length;
        tokenBegin = existingText.length + (spaceBefore ? 1 : 0);
        insertEnd = insertBegin + (spaceBefore ? 1 : 0) + text.trim().length;
        tokenEnd = tokenBegin + text.trim().length
        sentenceTokenEnd = tokenEnd; // No trailing space at end
        // For proper partitioning, sentence token should start where the previous sentence token ended
        // If no previous token, start from the insertion point
        sentenceTokenBegin = insertBegin; // Start from insertion point, let server handle partitioning
      }
      // Insert in middle
      else {
        const before = existingText.substring(0, insertPosition);
        const after = existingText.substring(insertPosition);
        const spaceBefore = before.endsWith(' ') ? '' : ' ';
        const spaceAfter = after.startsWith(' ') ? '' : ' ';

        insertedText = spaceBefore + text.trim() + spaceAfter;
        insertBegin = insertPosition;
        insertEnd = insertBegin + spaceBefore.length + text.trim().length + spaceAfter.length;
        tokenBegin = insertPosition + (spaceBefore ? 1 : 0);
        tokenEnd = tokenBegin + text.trim().length
        sentenceTokenEnd = tokenEnd + (spaceAfter ? spaceAfter.length : 0); // Include trailing space
        // For proper partitioning, sentence token should start where the previous sentence token ended
        // If no previous token, start from the insertion point
        sentenceTokenBegin = insertBegin; // Start from insertion point, let server handle partitioning
      }

      // Submit to API
      client.beginBatch();
      client.texts.update(textId, [{type: "insert", index: insertBegin, value: insertedText}]);
      client.tokens.create(
          alignmentTokenLayer.id,
          textId,
          tokenBegin,
          tokenEnd,
          undefined,
          {
            timeBegin: selection.start,
            timeEnd: selection.end
          }
      );
      client.tokens.create(
          sentenceTokenLayer.id,
          textId,
          sentenceTokenBegin,
          sentenceTokenEnd
      );
      await client.submitBatch();
      
      // Reload to get updated token positions from server
      if (onAlignmentCreated) {
        onAlignmentCreated();
      }
      
    } catch (error) {
      handleStrictModeError(error, 'create alignment');
      throw error;
    } finally {
      setIsProcessing(false);
    }
  }, [parsedDocument, selection, client, isProcessing, onAlignmentCreated, handleStrictModeError]);

  // Edit existing alignment
  const editAlignment = useCallback(async (text, existingAlignment) => {
    if (!text.trim() || isProcessing || !existingAlignment) return;
    
    setIsProcessing(true);
    try {
      // Get the text layer ID from parsed document
      const textId = parsedDocument?.layers?.primaryTextLayer?.text?.id;
      if (!textId) {
        throw new Error('Text layer not found');
      }

      // Get current text
      const currentText = parsedDocument?.document?.text?.body || '';
      
      // Replace the portion of text that corresponds to this alignment
      const tokenBegin = existingAlignment.begin;
      const tokenEnd = existingAlignment.end;
      
      const beforeText = currentText.substring(0, tokenBegin);
      const afterText = currentText.substring(tokenEnd);
      const newText = beforeText + text.trim() + afterText;

      // Update the text
      try {
        // Editing text might have caused the token to shrink--new content at the end will not automatically cause the
        // token to grow, and more dramatically, if the entirety of the content was changed, it may have been deleted.
        // Assume that it did not change at first, and use the `_tokenizationDirty` flag to trigger any necessary sentence
        // expansion during parsing.
        client.beginBatch();
        client.texts.update(textId, newText);
        client.tokens.update(existingAlignment.id, tokenBegin, tokenBegin + text.trim().length);
        client.texts.setMetadata(textId, {...parsedDocument.document.text.metadata, _tokenizationDirty: true})
        await client.submitBatch();
        
        // Reload to get updated token positions from server
        if (onAlignmentCreated) {
          onAlignmentCreated();
        }
      } catch (e) {
        // We failed--404 means the entirety of the contents was replaced.
        if (e.status === 404) {
          client.beginBatch();
          client.texts.update(textId, newText);
          client.tokens.create(
              parsedDocument?.layers?.alignmentTokenLayer.id,
              textId,
              tokenBegin,
              tokenBegin + text.trim().length,
              undefined,
              {timeBegin: selection.start, timeEnd: selection.end}
          );
          // We know we're replacing the entirety of the content if we got here, so just make a new sentence token
          client.tokens.create(
              parsedDocument?.layers?.sentenceTokenLayer.id,
              textId,
              tokenBegin,
              tokenBegin + text.trim().length,
          );
          await client.submitBatch();
          
          // Reload to get updated token positions from server
          if (onAlignmentCreated) {
            onAlignmentCreated();
          }
        } else {
          throw e;
        }
      }
      
    } catch (error) {
      handleStrictModeError(error, 'edit alignment');
      throw error;
    } finally {
      setIsProcessing(false);
    }
  }, [parsedDocument, selection, client, isProcessing, onAlignmentCreated, handleStrictModeError]);

  // Align existing baseline text
  const alignBaseline = useCallback(async (text) => {
    if (!text.trim() || isProcessing) return;
    
    setIsProcessing(true);
    try {
      // Get necessary layer IDs
      const primaryTextLayer = parsedDocument?.layers?.primaryTextLayer;
      const alignmentTokenLayer = parsedDocument?.layers?.alignmentTokenLayer;
      const sentenceTokenLayer = parsedDocument?.layers?.sentenceTokenLayer;
      
      if (!primaryTextLayer || !alignmentTokenLayer || !sentenceTokenLayer) {
        throw new Error('Required layers not found');
      }

      // Get text boundaries
      const { leftBoundary, rightBoundary } = getAvailableTextBoundaries();
      const fullText = parsedDocument?.document?.text?.body || '';
      
      // Find the actual text boundaries that match the user's selection
      const availableText = fullText.substring(leftBoundary, rightBoundary);
      const trimmedText = text.trim();
      
      // Find where in the available text our selection starts and ends
      const startInAvailable = availableText.indexOf(trimmedText);
      if (startInAvailable === -1) {
        throw new Error('Selected text not found in available text range');
      }
      
      // Calculate absolute positions
      const actualBegin = leftBoundary + startInAvailable;
      const actualEnd = actualBegin + trimmedText.length;
      
      // Don't modify the text, just create alignment token for existing text
      const textId = parsedDocument?.layers?.primaryTextLayer?.text?.id;
      
      client.beginBatch();
      
      // Create alignment token
      client.tokens.create(
        alignmentTokenLayer.id,
        textId,
        actualBegin,
        actualEnd,
        undefined,
        {
          timeBegin: selection.start,
          timeEnd: selection.end
        }
      );
      
      const result = await client.submitBatch();
      
      // Get the real ID from the API response
      const alignmentTokenId = result[result.length - 1].body.id;
      
      // Create optimistic alignment token
      const newAlignmentToken = {
        id: alignmentTokenId,
        text: textId,
        begin: actualBegin,
        end: actualEnd,
        metadata: {
          timeBegin: selection.start,
          timeEnd: selection.end
        },
        annotations: {}
      };
      
      // Add to docProxy alignmentTokens array optimistically
      const docProxy = getDocProxy();
      if (!docProxy.alignmentTokens) {
        docProxy.alignmentTokens = [];
      }
      docProxy.alignmentTokens.push(newAlignmentToken);
      
      // Sort by begin position to maintain order
      docProxy.alignmentTokens.sort((a, b) => a.begin - b.begin);
      
    } catch (error) {
      handleStrictModeError(error, 'align baseline text');
      throw error;
    } finally {
      setIsProcessing(false);
    }
  }, [parsedDocument, selection, client, isProcessing, getAvailableTextBoundaries, onAlignmentCreated, handleStrictModeError, getDocProxy]);

  // Delete alignment
  const deleteAlignment = useCallback(async (existingAlignment) => {
    if (!existingAlignment || isProcessing) return;
    
    setIsProcessing(true);
    try {
      // Get the text layer ID from parsed document
      const textId = parsedDocument?.layers?.primaryTextLayer?.text?.id;
      if (!textId) {
        throw new Error('Text layer not found');
      }

      // Get current text
      const currentText = parsedDocument?.document?.text?.body || '';
      
      // Remove the portion of text that corresponds to this alignment
      const tokenBegin = existingAlignment.begin;
      const tokenEnd = existingAlignment.end;
      
      let beforeText = currentText.substring(0, tokenBegin);
      let afterText = currentText.substring(tokenEnd);

      let trimIndex = beforeText.length;
      for (let i = beforeText.length - 1; i >= 0; i--) {
        if (/\s/.test(beforeText[i])) {
          trimIndex = i;
        } else {
          break;
        }
      }
      beforeText = beforeText.substring(0, trimIndex);
      trimIndex = 0;
      for (let i = 0; i < afterText.length; i++) {
        if (/\s/.test(afterText[i])) {
          trimIndex = i;
        } else {
          break;
        }
      }
      afterText = afterText.substring(trimIndex);
      
      const numDeleted = currentText.length - (afterText.length + beforeText.length);
      const index = beforeText.length

      // Update the text
      await client.texts.update(textId, [{type: "delete", index: index, value: numDeleted}]);
      
      // Notify parent to refresh
      if (onAlignmentCreated) {
        onAlignmentCreated();
      }
      
    } catch (error) {
      handleStrictModeError(error, 'delete alignment');
      throw error;
    } finally {
      setIsProcessing(false);
    }
  }, [parsedDocument, client, isProcessing, onAlignmentCreated, handleStrictModeError]);

  return {
    // State
    isProcessing,
    
    // Operations
    createAlignment,
    editAlignment,
    alignBaseline,
    deleteAlignment,
    
    // Calculations
    getAvailableTextBoundaries,
    getAvailableText,
    getExistingAlignment,
    canAlign
  };
};