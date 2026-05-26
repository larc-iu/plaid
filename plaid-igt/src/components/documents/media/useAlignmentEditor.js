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

  // Find an existing alignment that overlaps [begin, end) (excluding excludeId).
  // The alignment layer is :non-overlapping, so any overlap will be rejected by
  // the server with 409. Check up-front so we can show a clean error.
  // Two ranges overlap iff a.begin < b.end && a.end > b.begin.
  //
  // TODO: callers in createAlignment/editAlignment compare against PRE-edit
  // offsets, but the server checks POST-cascade offsets. This can produce
  // false UX rejections when the cascade would shift existing alignments out
  // of the way. Server still enforces correctly; only the pre-check is
  // optimistic. Fix: reindex existing alignments to post-cascade positions
  // before comparing, or drop the pre-check and rely on the server 409.
  const findOverlappingAlignment = useCallback((begin, end, excludeId = null) => {
    const tokens = parsedDocument?.alignmentTokens || [];
    return tokens.find(t =>
        t.id !== excludeId &&
        t.begin < end &&
        t.end > begin
    ) || null;
  }, [parsedDocument]);

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

      // Track whether we end up in the temporal-inversion fallback (set in the
      // ordering-violation branch below) so we can show a more informative
      // error if the resulting position collides with an existing alignment.
      let temporalInversion = false;

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
          temporalInversion = true;
        } else {
          // Normal case - insert after the "after" token
          insertPosition = insertAfterToken.end;
        }
      }

      // Insert text with proper spacing
      let insertedText;
      let insertBegin;
      let tokenBegin, tokenEnd;

      // Insert at the front
      if (insertPosition === 0) {
        const spaceAfter = (existingText ? ' ' : '')
        insertedText = text.trim() + spaceAfter;

        tokenBegin = 0;
        insertBegin = 0;
        tokenEnd = text.trim().length
      }
      // Insert at end
      else if (insertPosition >= existingText.length) {
        const spaceBefore = existingText ? ' ' : '';
        insertedText = spaceBefore + text.trim();

        insertBegin = existingText.length;
        tokenBegin = existingText.length + (spaceBefore ? 1 : 0);
        tokenEnd = tokenBegin + text.trim().length
      }
      // Insert in middle
      else {
        const before = existingText.substring(0, insertPosition);
        const after = existingText.substring(insertPosition);
        const spaceBefore = before.endsWith(' ') ? '' : ' ';
        const spaceAfter = after.startsWith(' ') ? '' : ' ';

        insertedText = spaceBefore + text.trim() + spaceAfter;
        insertBegin = insertPosition;
        tokenBegin = insertPosition + (spaceBefore ? 1 : 0);
        tokenEnd = tokenBegin + text.trim().length
      }

      // Pre-check: the alignment layer is :non-overlapping, so reject up-front if
      // the new alignment's range would overlap an existing alignment. (The server
      // would 409 anyway; this gives a clean error message.)
      const overlap = findOverlappingAlignment(tokenBegin, tokenEnd);
      if (overlap) {
        notifications.show({
          title: 'Cannot create alignment',
          message: temporalInversion
            ? 'Cannot insert alignment: temporal and positional ordering conflict. Delete the conflicting alignment first.'
            : 'The new alignment range overlaps an existing alignment.',
          color: 'red'
        });
        return;
      }

      const newTextLength = existingText.length + insertedText.length;
      const hasExistingSentences = (parsedDocument?.sentences || []).length > 0;

      // Submit to API
      //
      // Sentence layer is now :partitioning. We do NOT create a sentence here in
      // the normal case: the server's text-edit cascade reindexes surviving
      // partitioning tokens and `compensate-after-cascade` extends them to close
      // any gap the insert opens (a boundary-aligned insert leaves a gap; an
      // interior insert grows the containing sentence directly). Either way the
      // partition over [0, newTextLength) ends up covering the inserted text.
      //
      // The one case the cascade can't handle is an empty partitioning layer
      // (no existing sentences) — compensate skips empty layers, so we must
      // bulk-create to establish the partition over the new text.
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
      if (!hasExistingSentences && newTextLength > 0) {
        client.tokens.bulkCreate([{
          tokenLayerId: sentenceTokenLayer.id,
          text: textId,
          begin: 0,
          end: newTextLength,
        }]);
      }
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
  }, [parsedDocument, selection, client, isProcessing, onAlignmentCreated, handleStrictModeError, findOverlappingAlignment]);

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

      const alignmentTokenLayer = parsedDocument?.layers?.alignmentTokenLayer;
      const sentenceTokenLayer = parsedDocument?.layers?.sentenceTokenLayer;
      if (!alignmentTokenLayer || !sentenceTokenLayer) {
        throw new Error('Required layers not found');
      }

      // Get current text
      const currentText = parsedDocument?.document?.text?.body || '';

      // Replace the portion of text that corresponds to this alignment
      const tokenBegin = existingAlignment.begin;
      const tokenEnd = existingAlignment.end;

      const replacement = text.trim();
      const newAlignmentEnd = tokenBegin + replacement.length;
      const newTextLength = currentText.length - (tokenEnd - tokenBegin) + replacement.length;

      // Pre-check: the alignment layer is :non-overlapping. The new alignment
      // extent must not collide with any OTHER alignment (the one being edited
      // is excluded since it's about to be deleted by the text-edit cascade).
      // The server would 409 anyway; this gives a clean error.
      const overlap = findOverlappingAlignment(tokenBegin, newAlignmentEnd, existingAlignment.id);
      if (overlap) {
        notifications.show({
          title: 'Cannot edit alignment',
          message: 'The updated alignment range would overlap an existing alignment.',
          color: 'red'
        });
        return;
      }

      // We use an explicit ops array (one delete + one insert) for texts.update
      // rather than passing the full new text. The string form makes the server
      // compute an editscript diff whose deletion range can be narrower than
      // [tokenBegin, tokenEnd), which causes the cascade to keep the existing
      // alignment token and trips an ASSERT against tokens.create. With an
      // explicit delete over exactly [tokenBegin, tokenEnd), the alignment
      // token at that range is fully contained and the cascade deletes it,
      // so we always re-create it alongside the text update.
      const textOps = [
        { type: 'delete', index: tokenBegin, value: tokenEnd - tokenBegin },
        { type: 'insert', index: tokenBegin, value: replacement }
      ];

      // Predict whether the text-edit cascade will leave the sentence partition
      // empty. The cascade deletes any token fully contained in the deletion
      // range [tokenBegin, tokenEnd). A sentence at [sb, se) where sb >=
      // tokenBegin && se <= tokenEnd is contained and will be wiped.
      //
      // Conservative predictor: if every existing sentence sits inside the
      // alignment's old range (or there are none), the cascade wipes them all
      // and we must re-establish the partition with a bulkCreate. Otherwise
      // some sentence survives and compensate-after-cascade will cover the new
      // text — adding a bulkCreate on top of that would conflict with the
      // partition-establish ASSERT.
      const sentences = parsedDocument?.sentences || [];
      const cascadeWipesAllSentences = sentences.length === 0
          || sentences.every(s => s.begin >= tokenBegin && s.end <= tokenEnd);

      client.beginBatch();
      client.texts.update(textId, textOps);
      client.tokens.create(
          alignmentTokenLayer.id,
          textId,
          tokenBegin,
          newAlignmentEnd,
          undefined,
          {timeBegin: selection.start, timeEnd: selection.end}
      );
      if (cascadeWipesAllSentences && newTextLength > 0) {
        client.tokens.bulkCreate([{
          tokenLayerId: sentenceTokenLayer.id,
          text: textId,
          begin: 0,
          end: newTextLength,
        }]);
      }
      await client.submitBatch();

      // Reload to get updated token positions from server
      if (onAlignmentCreated) {
        onAlignmentCreated();
      }

    } catch (error) {
      handleStrictModeError(error, 'edit alignment');
      throw error;
    } finally {
      setIsProcessing(false);
    }
  }, [parsedDocument, selection, client, isProcessing, onAlignmentCreated, handleStrictModeError, findOverlappingAlignment]);

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

      // Pre-check: the alignment layer is :non-overlapping, so reject if the
      // new alignment would overlap an existing one. getAvailableTextBoundaries
      // already constrains the range against neighbors, but only relative to the
      // CURRENT selection — defensively confirm before submitting.
      const overlap = findOverlappingAlignment(actualBegin, actualEnd);
      if (overlap) {
        notifications.show({
          title: 'Cannot align text',
          message: 'The selected text range overlaps an existing alignment.',
          color: 'red'
        });
        return;
      }

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
  }, [parsedDocument, selection, client, isProcessing, getAvailableTextBoundaries, onAlignmentCreated, handleStrictModeError, getDocProxy, findOverlappingAlignment]);

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

      // Strip trailing whitespace from beforeText and leading whitespace from
      // afterText so the deletion swallows the surrounding inter-token spaces.
      beforeText = beforeText.replace(/\s+$/, '');
      afterText = afterText.replace(/^\s+/, '');
      
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