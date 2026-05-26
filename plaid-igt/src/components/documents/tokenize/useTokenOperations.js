import { useSnapshot } from 'valtio';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import { useServiceRequest } from '../hooks/useServiceRequest.js';
import { notifications } from '@mantine/notifications';
import {
  tokenizeText,
  findUntokenizedRanges,
  getIgnoredTokensConfig,
  validateTokenization
} from '../../../utils/tokenizationUtils.js';
import documentsStore from '../../../stores/documentsStore.js';
import {useEffect} from "react";

function mergeGaps(sentProxy) {
  if (!sentProxy?.pieces || sentProxy.pieces.length < 2) return;
  
  for (let i = sentProxy.pieces.length - 2; i >= 0; i--) {
    const current = sentProxy.pieces[i];
    const next = sentProxy.pieces[i + 1];
    
    if (current.type === "gap" && next.type === "gap") {
      // Merge the gaps: extend current to include next
      current.content = current.content + next.content;
      current.end = next.end;
      
      // Remove the next gap
      sentProxy.pieces.splice(i + 1, 1);
    }
  }
}

/**
 * Find morpheme tokens that are coincident (have exact same begin/end) with given word tokens
 * @param {Array} wordTokens - Array of word token objects with begin/end properties
 * @param {Object} layers - Document layers object
 * @returns {Array} Array of morpheme token IDs to delete
 */
function findCoincidentMorphemes(wordTokens, layers) {
  if (!layers?.morphemeTokenLayer?.tokens || !wordTokens?.length) {
    return [];
  }

  const morphemeIds = [];
  const wordRanges = new Set(wordTokens.map(token => `${token.begin}-${token.end}`));

  layers.morphemeTokenLayer.tokens.forEach(morpheme => {
    const morphemeRange = `${morpheme.begin}-${morpheme.end}`;
    if (wordRanges.has(morphemeRange)) {
      morphemeIds.push(morpheme.id);
    }
  });

  return morphemeIds;
}

export const useTokenOperations = (projectId, documentId, reload, client) => {
  const handleError = useStrictModeErrorHandler(reload);
  
  // Get the document snapshot at the hook level
  const docSnap = useSnapshot(documentsStore[projectId][documentId]);
  const layers = docSnap.layers;
  const text = docSnap.document.text;
  const project = docSnap.project;
  
  // Get UI proxy for mutations
  const docProxy = documentsStore[projectId][documentId];
  const uiProxy = docProxy.ui.tokenize;
  const uiSnap = docSnap.ui.tokenize;
  
  // NLP service hook
  const {
    availableServices,
    isDiscovering,
    discoverServices,
    isProcessing,
    requestService,
    hasServices,
    progressPercent,
    progressMessage
  } = useServiceRequest();
  
  // Progress tracking helper
  const updateProgress = (percent, operation) => {
    uiProxy.tokenizationProgress = percent;
    uiProxy.currentOperation = operation;
  };

  // Discover services on component mount
  useEffect(() => {
    if (project?.id) {
      console.log('[useTokenOperations] Component mounted, discovering services');
      discoverServices(project.id);
    }
  }, [project?.id, discoverServices]);

  // Populate options when services change
  useEffect(() => {
    // Build options list with discovered services
    const options = [
      { value: 'rule-based-punctuation', label: 'Rule-based Punctuation' }
    ];

    // Add discovered tokenization services (filter by tok: prefix)
    availableServices.forEach(service => {
      if (service.serviceId.startsWith('tok:')) {
        options.push({
          value: `service:${service.serviceId}`,
          label: service.serviceName
        });
      }
    });

    docProxy.ui.tokenize.algorithmOptions = options;

    // Restore cached selection when options are available
    if (options.length > 1 && !uiSnap.hasRestoredCache) {
      const cached = localStorage.getItem('plaid_tokenization_algorithm');
      const isAvailable = cached && options.some(opt => opt.value === cached);

      if (isAvailable) {
        docProxy.ui.tokenize.algorithm = cached;
      } else {
        if (cached) localStorage.removeItem('plaid_tokenization_algorithm');
        docProxy.ui.tokenize.algorithm = 'rule-based-punctuation';
      }

      docProxy.ui.tokenize.hasRestoredCache = true;
    }
  }, [availableServices, uiSnap.hasRestoredCache, docProxy]);

  const splitToken = async (tokenId, sentProxy, token, pieceIndex, splitOffset) => {
    try {
      const leftText = token.content.slice(0, splitOffset + 1);
      const rightText = token.content.slice(splitOffset + 1);

      const leftEnd = token.begin + leftText.length;
      const rightStart = token.end - rightText.length;

      // Update the existing token optimistically
      Object.assign(sentProxy.pieces[pieceIndex], {
        end: leftEnd,
        content: leftText
      });

      // Insert the new token optimistically with a temporary ID
      const tempId = crypto.randomUUID();
      sentProxy.pieces.splice(pieceIndex + 1, 0, {
        id: tempId,
        type: "token",
        content: rightText,
        begin: rightStart,
        end: token.end,
        isToken: true,
      });

      // Wipe coincident morphemes before the word split (their analysis is invalidated
      // by the new word boundary; server-cascade-split would produce nonsense form pairs).
      // Wrap the morpheme delete + split in a single batch so a server-side failure on
      // split rolls back the morpheme delete (otherwise the morphemes would be silently
      // lost while the word remained unchanged).
      client.beginBatch();
      const morphemeIds = findCoincidentMorphemes([token], layers);
      if (morphemeIds.length > 0) {
        client.tokens.bulkDelete(morphemeIds);
      }
      // Server enforces partition/nesting; split returns the new right-half token.
      client.tokens.split(tokenId, leftEnd);
      const results = await client.submitBatch();

      // The split op is the last queued op; its body is `{id: <new right token id>}`.
      const newRightToken = results[results.length - 1].body;
      sentProxy.pieces[pieceIndex + 1].id = newRightToken.id;
    } catch (error) {
      handleError(error, 'Split token', { rollback: true });
    }
  };

  const deleteToken = async (sentProxy, sentIndex, piece, pieceIndex) => {
    try {
      // Remove the token from the local store optimistically and replace with gap
      sentProxy.pieces.splice(pieceIndex, 1, {
        type: "gap",
        isToken: false,
        begin: piece.begin,
        end: piece.end,
        content: piece.content,
      });
      mergeGaps(sentProxy);

      // Server cascades word deletion → morpheme deletion (morpheme layer's parent is word).
      await client.tokens.delete(piece.id);
    } catch (error) {
      handleError(error, 'Delete token', { rollback: true });
    }
  };

  const createToken = async (sentProxy, piece, pieceIndex, selectionStart, selectionLength) => {
    const layers = docSnap.layers;
    const text = docSnap.document.text;

    try {
      // Calculate actual positions in the text
      const actualStart = piece.begin + selectionStart;
      const actualEnd = actualStart + selectionLength;

      // Get the selected text content
      const selectedText = text.body.slice(actualStart, actualEnd);

      // Create temporary ID for optimistic update
      const tempId = crypto.randomUUID();

      // Find where to insert the new token in the pieces array
      const newToken = {
        id: tempId,
        type: "token",
        content: selectedText,
        begin: actualStart,
        end: actualEnd,
        isToken: true,
      };

      // Split the current gap into three parts: before, token, after
      const newPieces = [];
      let newPieceIndex = pieceIndex;
      
      // Part before selection (if any)
      if (selectionStart > 0) {
        newPieceIndex += 1;
        newPieces.push({
          type: "gap",
          isToken: false,
          begin: piece.begin,
          end: actualStart,
          content: piece.content.slice(0, selectionStart),
        });
      }

      // The new token
      newPieces.push(newToken);

      // Part after selection (if any)
      if (actualEnd < piece.end) {
        newPieces.push({
          type: "gap",
          isToken: false,
          begin: actualEnd,
          end: piece.end,
          content: piece.content.slice(selectionStart + selectionLength),
        });
      }

      // Replace the original gap with the new pieces
      sentProxy.pieces.splice(pieceIndex, 1, ...newPieces);

      // Submit to backend
      const result = await client.tokens.create(
        layers.primaryTokenLayer.id,
        text.id,
        actualStart,
        actualEnd
      );

      // Update with real ID
      sentProxy.pieces[newPieceIndex].id = result.id;
    } catch (error) {
      handleError(error, 'Create token from selection', { rollback: true });
    }
  };

  const createTokenFromSelection = async (event, sentProxy, piece, pieceIndex) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    const spanElement = event.target;
    try {
      // Calculate the actual selection offset within the span using Range API
      const spanRange = document.createRange();
      spanRange.setStart(spanElement.firstChild || spanElement, 0);
      spanRange.setEnd(range.startContainer, range.startOffset);

      const selectionStart = spanRange.toString().length;
      const selectionLength = selectedText.length;

      // Validate that the selection is within the span bounds
      if (selectionStart < 0 || selectionStart + selectionLength > spanElement.textContent.length) {
        return;
      }

      // Create the token
      await createToken(sentProxy, piece, pieceIndex, selectionStart, selectionLength);
    } catch (error) {
      handleError(error, 'Create token from selection');
    } finally {
      // Always clear the selection
      selection.removeAllRanges();
    }
  };

  const mergeTokens = async (sentProxy, tokenIds) => {
    if (!tokenIds || tokenIds.size <= 1) return;

    try {
      let firstIndex = sentProxy.pieces.length, lastIndex = -1;
      const tokensToMerge = [];

      sentProxy.pieces.forEach((piece, index) => {
        if (piece.isToken && tokenIds.has(piece.id)) {
          firstIndex = index < firstIndex ? index : firstIndex;
          lastIndex = index > lastIndex ? index : lastIndex;
          tokensToMerge.push(piece);
        }
      })

      // Sort merge targets by begin so we merge adjacent pairs into the first token in order.
      tokensToMerge.sort((a, b) => a.begin - b.begin);

      const firstToken = sentProxy.pieces[firstIndex];
      const lastToken = sentProxy.pieces[lastIndex];
      const mergedContent = text.body.slice(firstToken.begin, lastToken.end);
      Object.assign(sentProxy.pieces[firstIndex], { end: lastToken.end, content: mergedContent });
      sentProxy.pieces.splice(firstIndex + 1, lastIndex - firstIndex);

      // Wipe coincident morphemes — same rationale as splitToken.
      // Wrap the morpheme delete + sequential merges in one batch so that if any merge
      // fails the morpheme delete (and any earlier successful merges) roll back, leaving
      // the word + morpheme state consistent rather than silently mutilated.
      client.beginBatch();
      const morphemeIds = findCoincidentMorphemes(tokensToMerge, layers);
      if (morphemeIds.length > 0) {
        client.tokens.bulkDelete(morphemeIds);
      }
      // Sequential merges into firstToken. The merge endpoint requires that the resulting
      // extent not engulf a third token, so we merge into firstToken in begin-order.
      // The server processes batch ops sequentially, so each merge sees firstToken's
      // widened extent from the prior op.
      for (let i = 1; i < tokensToMerge.length; i++) {
        client.tokens.merge(firstToken.id, tokensToMerge[i].id);
      }
      await client.submitBatch();
    } catch (error) {
      handleError(error, 'Merge tokens', { rollback: true });
    }
  };

  const mergeSentence = async (sentSnap, sentIndex, docProxy) => {
    try {
      const previousSentenceProxy = docProxy.sentences[sentIndex - 1];
      const previousSentenceSnap = docSnap.sentences[sentIndex - 1];
      const newEnd = sentSnap.end;

      // Optimistically update the previous sentence to cover both ranges
      Object.assign(previousSentenceProxy, { end: newEnd });
      if (sentSnap.pieces.length > 0) {
        previousSentenceProxy.pieces.splice(previousSentenceSnap.pieces.length, 0, ...sentSnap.pieces);
      }
      mergeGaps(previousSentenceProxy);

      // Remove the current sentence from the document
      docProxy.sentences.splice(sentIndex, 1);

      // Partition-preserving merge: server requires this for :partitioning sentence layer.
      await client.tokens.merge(previousSentenceProxy.id, sentSnap.id);
    } catch (error) {
      handleError(error, 'Merge sentence', { rollback: true });
    }
  };

  const splitSentence = async (token, sentProxy, docProxy) => {
    try {
      // Check if this is the first token in the sentence
      if (token.begin === sentProxy.begin) {
        throw new Error('Cannot create a new sentence at the first token of a sentence');
      }

      // Find the sentence index
      const sentenceIndex = docProxy.sentences.findIndex(s => s.id === sentProxy.id);
      if (sentenceIndex === -1) {
        throw new Error('Sentence not found');
      }

      // Calculate split points
      const originalEnd = sentProxy.end;
      const splitPoint = token.begin;

      // Optimistically update the current sentence to end at the token's position
      Object.assign(sentProxy, {
        end: splitPoint
      });

      // Split the pieces array at the token position
      const pieceIndex = sentProxy.pieces.findIndex(p => p.isToken && p.id === token.id);
      if (pieceIndex !== -1) {
        const beforePieces = sentProxy.pieces.slice(0, pieceIndex);
        const afterPieces = sentProxy.pieces.slice(pieceIndex);

        sentProxy.pieces = beforePieces;

        const tempId = crypto.randomUUID();
        const newSentenceProxy = {
          id: tempId,
          begin: splitPoint,
          end: originalEnd,
          pieces: afterPieces,
          dragState: {
            isDragging: false,
            startToken: null,
            selectedTokenIds: new Set()
          }
        };

        docProxy.sentences.splice(sentenceIndex + 1, 0, newSentenceProxy);
      }

      // Partition-preserving split. Server splits straddling descendants (none expected,
      // since splitPoint is at a word boundary), preserving nesting.
      const newRightSentence = await client.tokens.split(sentProxy.id, splitPoint);

      const newSentenceProxy = docProxy.sentences[sentenceIndex + 1];
      if (newSentenceProxy) {
        newSentenceProxy.id = newRightSentence.id;
      }
    } catch (error) {
      handleError(error, 'Split sentence', { rollback: true });
    }
  };

  // Handle tokenization (both built-in and NLP services)
  const handleTokenize = async () => {
    uiProxy.isTokenizing = true;
    uiProxy.tokenizationProgress = 0;

    try {
      // Check if using an NLP service
      if (uiProxy.algorithm.startsWith('service:')) {
        const serviceId = uiProxy.algorithm.substring(8); // Remove 'service:' prefix

        updateProgress(10, 'Requesting tokenization from NLP service...');

        await requestService(
          project.id,
          docSnap.document.id,
          serviceId,
          {
            documentId: docSnap.document.id,
            textLayerId: layers.primaryTextLayer?.id,
            primaryTokenLayerId: layers.primaryTokenLayer.id,
            sentenceLayerId: layers.sentenceTokenLayer?.id
          },
          {
            successTitle: 'Tokenization Complete',
            successMessage: 'Document has been tokenized successfully',
            errorTitle: 'Tokenization Failed',
            errorMessage: 'An error occurred during tokenization'
          }
        );

        updateProgress(100, 'Tokenization complete!');

        if (reload) {
          reload();
        }

        return;
      }

      // Otherwise use built-in tokenization
      updateProgress(25, 'Analyzing text for tokens...');
      const existingTokens = docSnap.sentences.flatMap(s => s.pieces.filter(p => p.isToken)) || [];
      const ignoredTokensConfig = getIgnoredTokensConfig(project);
      const untokenizedRanges = findUntokenizedRanges(text.body, existingTokens);
      const newTokens = tokenizeText(text.body, ignoredTokensConfig, untokenizedRanges);

      updateProgress(50, 'Validating tokenization...');
      let validation = validateTokenization(newTokens, text.body);
      if (!validation.isValid) {
        throw new Error(`Tokenization validation failed: ${validation.errors.join(', ')}`);
      }

      if (newTokens.length > 0) {
        updateProgress(75, 'Creating tokens...');
        const tokenCreationRequests = newTokens.map(token => ({
          tokenLayerId: layers.primaryTokenLayer.id,
          text: text.id,
          begin: token.begin,
          end: token.end
        }));

        await client.tokens.bulkCreate(tokenCreationRequests);
      }

      updateProgress(100, 'Tokenization complete!');

      if (newTokens.length > 0) {
        notifications.show({
          title: 'Success',
          message: `Created ${newTokens.length} tokens`,
          color: 'green'
        });
      } else {
        notifications.show({
          title: 'Complete',
          message: 'Text is already fully tokenized',
          color: 'blue'
        });
      }

      if (reload) {
        reload();
      }

    } catch (error) {
      console.error('Tokenization failed:', error);
      notifications.show({
        title: 'Tokenization Failed',
        message: error.message || 'An error occurred during tokenization',
        color: 'red'
      });
    } finally {
      uiProxy.isTokenizing = false;
      uiProxy.tokenizationProgress = 0;
      uiProxy.currentOperation = '';
    }
  };

  // Clear all tokens
  const handleClearTokens = async () => {
    const existingTokens = docSnap.sentences.flatMap(s => s.pieces.filter(p => p.isToken)) || [];
    if (!existingTokens.length) return;

    try {
      uiProxy.isTokenizing = true;
      updateProgress(25, 'Deleting tokens...');

      const tokenIds = existingTokens.map(token => token.id);

      // Server cascades word deletion → morpheme deletion (morphemes nested under words).
      await client.tokens.bulkDelete(tokenIds);

      updateProgress(100, 'Tokens cleared!');

      notifications.show({
        title: 'Success',
        message: `Deleted ${tokenIds.length} tokens`,
        color: 'green'
      });

      if (reload) {
        reload();
      }

    } catch (error) {
      handleError(error, 'Clear tokens');
    } finally {
      uiProxy.isTokenizing = false;
      uiProxy.tokenizationProgress = 0;
      uiProxy.currentOperation = '';
    }
  };

  // Clear sentences (reset to single sentence)
  const handleClearSentences = async () => {
    const existingSentenceTokens = docSnap.sentences || [];
    if (!existingSentenceTokens.length || !layers.sentenceTokenLayer) return;

    try {
      uiProxy.isTokenizing = true;
      updateProgress(25, 'Resetting sentences...');

      // :partitioning layer rejects single create/delete; use bulkDelete + bulkCreate in a batch.
      // Server cascades sentence deletes → word + morpheme deletes (full hierarchy reset).
      const sentenceIds = existingSentenceTokens.map(sentence => sentence.id);

      client.beginBatch();
      client.tokens.bulkDelete(sentenceIds);
      if (text.body.length > 0) {
        client.tokens.bulkCreate([{
          tokenLayerId: layers.sentenceTokenLayer.id,
          text: text.id,
          begin: 0,
          end: text.body.length,
        }]);
      }
      await client.submitBatch();

      updateProgress(100, 'Sentence tokens reset!');

      notifications.show({
        title: 'Success',
        message: `Reset to single sentence`,
        color: 'green'
      });

      if (reload) {
        reload();
      }

    } catch (error) {
      handleError(error, 'Clear sentences');
    } finally {
      uiProxy.isTokenizing = false;
      uiProxy.tokenizationProgress = 0;
      uiProxy.currentOperation = '';
    }
  };

  return {
    splitToken,
    deleteToken,
    createTokenFromSelection,
    mergeTokens,
    mergeSentence,
    splitSentence,
    // NLP operations
    handleTokenize,
    handleClearTokens,
    handleClearSentences,
    updateProgress,
    // Service discovery
    availableServices,
    isDiscovering,
    discoverServices,
    isProcessing,
    requestService,
    hasServices,
    progressPercent,
    progressMessage
  };
};