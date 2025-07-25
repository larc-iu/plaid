import { useState, useMemo, useEffect, useCallback, memo, useRef } from 'react';
import { 
  Stack, 
  Text, 
  Paper,
  Button,
  Group,
  Alert,
  Divider,
  Progress,
  Select,
  Box,
  ActionIcon,
  Tooltip,
  Kbd,
  Title,
  Collapse,
  Pagination
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import IconChevronUp from '@tabler/icons-react/dist/esm/icons/IconChevronUp.mjs';
import IconCut from '@tabler/icons-react/dist/esm/icons/IconCut.mjs';
import IconQuestionMark from '@tabler/icons-react/dist/esm/icons/IconQuestionMark.mjs';
import { notifications } from '@mantine/notifications';
import {
  tokenizeText,
  findUntokenizedRanges,
  getIgnoredTokensConfig,
  validateTokenization
} from '../../../utils/tokenizationUtils.js';
import { useStrictClient, useIsViewingHistorical } from '../contexts/StrictModeContext.jsx';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import { useServiceRequest } from '../hooks/useServiceRequest.js';

// Helper component to render text with visible whitespace
const TextWithVisibleWhitespace = ({ text, style = {} }) => {
  // Split text into spans, marking whitespace with special styling
  const parts = text.split(/(\s+)/);
  
  return (
    <>
      {parts.map((part, index) => (
        <span
          key={index}
          style={{
            ...style,
            ...(part.match(/^\s+$/) ? {
              borderBottom: '1px dotted #aaa',
              paddingBottom: '1px'
            } : {})
          }}
        >
          {part}
        </span>
      ))}
    </>
  );
};

// Individual token component with inline splitting
const TokenComponent = ({ 
  span, 
  text, 
  onTokenClick, 
  onTokenRightClick, 
  onTokenSplit,
  onTokenDragStart,
  onTokenDragEnter,
  isSelected,
  isTokenDragging,
  isSplitting,
  hoveredSplitPosition,
  setHoveredSplitPosition,
  handleTokenSplit
}) => {
  // If this token is being split, show the splitting UI
  if (isSplitting) {
    return (
      <Box
        component="span"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '2px',
          padding: '4px',
          backgroundColor: '#f8f9fa',
          border: '2px solid #1976d2',
          borderRadius: '4px',
          margin: '1px'
        }}
      >
        {Array.from(span.content || text.slice(span.begin, span.end)).map((char, index) => (
          <Box key={`split-char-${span.begin}-${index}`} style={{ display: 'flex', alignItems: 'center' }}>
            <Text 
              style={{ 
                fontFamily: 'monospace',
                backgroundColor: '#fff',
                padding: '2px 4px',
                borderRadius: '2px',
                minWidth: '16px',
                textAlign: 'center',
                fontSize: '13px',
                border: '1px solid #dee2e6'
              }}
            >
              {char === ' ' ? '·' : char}
            </Text>
            {index < Array.from(span.content || text.slice(span.begin, span.end)).length - 1 && (
              <Box
                style={{
                  width: '20px',
                  height: '20px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: hoveredSplitPosition === index ? 1 : 0.5,
                  transition: 'opacity 0.2s ease',
                  backgroundColor: hoveredSplitPosition === index ? '#fff5f5' : 'transparent',
                  borderRadius: '2px'
                }}
                onMouseEnter={() => setHoveredSplitPosition(index)}
                onMouseLeave={() => setHoveredSplitPosition(null)}
                onClick={() => handleTokenSplit(span, index + 1)}
              >
                <IconCut 
                  size={12} 
                  color={hoveredSplitPosition === index ? '#e03131' : '#868e96'} 
                />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    );
  }

  // Normal token display
  return (
    <Box
      component="span"
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          onTokenClick(span, e);
        } else {
          onTokenSplit(span);
        }
      }}
      onContextMenu={(e) => onTokenRightClick(span, e)}
      onMouseDown={(e) => {
        if (!e.ctrlKey && !e.metaKey) {
          onTokenDragStart(span, e);
        }
      }}
      onMouseEnter={(e) => {
        if (isTokenDragging) {
          onTokenDragEnter(span);
        }
      }}
      style={{
        display: 'inline-block',
        margin: '1px',
        padding: '2px 4px',
        backgroundColor: isSelected ? '#1976d2' : '#e3f2fd',
        color: isSelected ? 'white' : 'inherit',
        border: `1px solid ${isSelected ? '#1565c0' : '#bbdefb'}`,
        borderRadius: '4px',
        fontSize: '13px',
        cursor: 'pointer',
        userSelect: 'none'
      }}
    >
      <TextWithVisibleWhitespace text={span.content || span.text} />
    </Box>
  );
};

// Memoized sentence component to improve performance
const SentenceComponent = memo(({ 
  sentence, 
  sentenceIndex, 
  text,
  handleDeleteSentence,
  handleTokenClick,
  handleTokenRightClick,
  handleTokenSplitStart,
  handleTokenDragStart,
  handleTokenDragEnter,
  handleTextSelection,
  handleTokenSplit,
  selectedTokens,
  isTokenDragging,
  splittingToken,
  hoveredSplitPosition,
  setHoveredSplitPosition
}) => {
  // Use pre-computed spans from documentParser for better performance
  const spans = sentence.spans || [];

  return (
    <Box
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        backgroundColor: sentenceIndex % 2 === 0 ? '#ffffff' : '#f8faff',
        padding: '8px 12px',
        marginLeft: '-70px'
      }}
    >
      {/* Sentence number */}
      <Text
        size="xs"
        c="dimmed"
        style={{
          position: 'absolute',
          left: '22px',
          top: '10px',
          fontFamily: 'monospace',
          userSelect: 'none',
          width: '20px',
          textAlign: 'right'
        }}
      >
        {sentenceIndex + 1}
      </Text>

      {/* Delete button - subtle, always visible (not on first sentence) */}
      {sentenceIndex > 0 && (
        <Box
          style={{
            position: 'absolute',
            left: '48px',
            top: '9px',
            zIndex: 10
          }}
        >
          <Tooltip label="Merge with above">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => handleDeleteSentence(sentence)}
              style={{
                backgroundColor: 'transparent',
                border: '1px solid #d0d7de',
                opacity: 0.6
              }}
            >
              <IconChevronUp size={12} />
            </ActionIcon>
          </Tooltip>
        </Box>
      )}

      {/* Sentence content */}
      <Box style={{ flex: 1, paddingLeft: '70px', whiteSpace: "pre-wrap" }}>
        {spans.map((span, spanIndex) =>
          span.isToken ? (
            <TokenComponent
              key={span.id ? `token-${span.id}` : `sentence-${sentenceIndex}-token-${span.begin}-${span.end}-${spanIndex}`}
              span={span}
              text={text}
              onTokenClick={handleTokenClick}
              onTokenRightClick={handleTokenRightClick}
              onTokenSplit={handleTokenSplitStart}
              onTokenDragStart={handleTokenDragStart}
              onTokenDragEnter={handleTokenDragEnter}
              isSelected={selectedTokens.has(span.id)}
              isTokenDragging={isTokenDragging}
              isSplitting={splittingToken?.id === span.id}
              hoveredSplitPosition={hoveredSplitPosition}
              setHoveredSplitPosition={setHoveredSplitPosition}
              handleTokenSplit={handleTokenSplit}
            />
          ) : (
            <span
              key={`text-${span.begin}-${span.end}`}
              data-begin={span.begin}
              data-end={span.end}
              style={{
                cursor: 'text',
                userSelect: 'text'
              }}
              onMouseUp={handleTextSelection}
              title="Select text to create token"
            >
              <TextWithVisibleWhitespace text={span.text} />
            </span>
          )
        )}
      </Box>
    </Box>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function to ensure re-renders when sentence data changes
  return (
    prevProps.sentence.id === nextProps.sentence.id &&
    prevProps.sentence.spans === nextProps.sentence.spans && // Check if spans reference changed
    prevProps.sentenceIndex === nextProps.sentenceIndex &&
    prevProps.text === nextProps.text &&
    prevProps.selectedTokens.size === nextProps.selectedTokens.size &&
    prevProps.isTokenDragging === nextProps.isTokenDragging &&
    prevProps.splittingToken?.id === nextProps.splittingToken?.id &&
    prevProps.hoveredSplitPosition === nextProps.hoveredSplitPosition
  );
});

SentenceComponent.displayName = 'SentenceComponent';

export const DocumentTokenize = ({ document, parsedDocument, project, onTokenizationComplete }) => {
  const client = useStrictClient();
  const isViewingHistorical = useIsViewingHistorical();
  const handleStrictModeError = useStrictModeErrorHandler(onTokenizationComplete);
  const [isTokenizing, setIsTokenizing] = useState(false);
  const [tokenizationProgress, setTokenizationProgress] = useState(0);
  const [currentOperation, setCurrentOperation] = useState('');
  const [algorithm, setAlgorithm] = useState('');
  const [algorithmOptions, setAlgorithmOptions] = useState([]);
  const [hasRestoredCache, setHasRestoredCache] = useState(false);

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

  // Token drag selection state
  const [isTokenDragging, setIsTokenDragging] = useState(false);
  const [selectedTokens, setSelectedTokens] = useState(new Set());
  const [dragStartToken, setDragStartToken] = useState(null);

  // Token splitting state
  const [splittingToken, setSplittingToken] = useState(null);
  const [hoveredSplitPosition, setHoveredSplitPosition] = useState(null);

  // Help section collapse state
  const [helpOpened, setHelpOpened] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const sentencesPerPage = 100;

  // Get layer information
  const primaryTextLayer = project?.textLayers?.find(layer => layer.config?.plaid?.primary);
  const primaryTokenLayer = primaryTextLayer?.tokenLayers?.find(layer => layer.config?.plaid?.primary);
  const sentenceTokenLayer = primaryTextLayer?.tokenLayers?.find(layer => layer.config?.plaid?.sentence);

  const text = parsedDocument?.document?.text?.body || '';
  
  // Memoize expensive calculations - use more specific dependencies
  const existingTokens = useMemo(() => 
    parsedDocument?.sentences?.flatMap(s => s.tokens) || [], 
    [parsedDocument?.sentences]
  );
  
  const existingSentenceTokens = parsedDocument?.sentences || [];
  const sortedSentences = parsedDocument?.sortedSentences || [];
  const findSentenceForToken = parsedDocument?.findSentenceForToken;
  
  // Get lookup maps for O(1) operations
  const tokenLookup = parsedDocument?.tokenLookup;
  const sentenceLookup = parsedDocument?.sentenceLookup;
  const tokenPositionMaps = parsedDocument?.tokenPositionMaps;
  const sentenceIndexLookup = parsedDocument?.sentenceIndexLookup;

  // Get text ID from document structure
  const textId = document?.textLayers?.find(layer => layer.config?.plaid?.primary)?.text?.id;

  const ignoredTokensConfig = getIgnoredTokensConfig(project);

  // Clear tokens handler
  const handleClearTokens = async () => {
    if (!existingTokens.length) return;

    try {
      setIsTokenizing(true);
      updateProgress(25, 'Deleting tokens...');

      const tokenIds = existingTokens.map(token => token.id);
      await client.tokens.bulkDelete(tokenIds);

      updateProgress(100, 'Tokens cleared!');

      notifications.show({
        title: 'Success',
        message: `Deleted ${tokenIds.length} tokens`,
        color: 'green'
      });

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      handleStrictModeError(error, 'Clear tokens');
    } finally {
      setIsTokenizing(false);
      setTokenizationProgress(0);
      setCurrentOperation('');
    }
  };

  // Clear sentences handler - replace all sentences with single sentence covering entire text
  const handleClearSentences = async () => {
    if (!existingSentenceTokens.length || !sentenceTokenLayer) return;

    try {
      setIsTokenizing(true);
      updateProgress(25, 'Resetting sentence tokens...');

      client.beginBatch();

      // Delete all existing sentence tokens
      const sentenceIds = existingSentenceTokens.map(sentence => sentence.id);
      for (const sentenceId of sentenceIds) {
        client.tokens.delete(sentenceId);
      }

      updateProgress(50, 'Creating single sentence token...');

      // Create a single sentence token covering the entire text
      await client.tokens.create(
        sentenceTokenLayer.id,
        textId,
        0,
        text.length
      );

      await client.submitBatch();

      updateProgress(100, 'Sentence tokens reset!');

      notifications.show({
        title: 'Success',
        message: `Reset to single sentence token`,
        color: 'green'
      });

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      handleStrictModeError(error, 'Clear sentence tokens');
    } finally {
      setIsTokenizing(false);
      setTokenizationProgress(0);
      setCurrentOperation('');
    }
  };

  // Handle keyboard shortcuts
  useHotkeys([
    ['escape', () => {
      if (splittingToken) {
        setSplittingToken(null);
        setHoveredSplitPosition(null);
      }
    }],
  ]);

  const updateProgress = (percent, operation) => {
    setTokenizationProgress(percent);
    setCurrentOperation(operation);
  };

  // Handle CTRL+click on token to create new sentence
  const handleTokenClick = useCallback(async (token, event) => {
    if (!event.ctrlKey && !event.metaKey) return;

    event.preventDefault();

    try {
      // Find the sentence that contains this token
      const containingSentence = findSentenceForToken ? findSentenceForToken(token) : null;

      if (!containingSentence) {
        throw new Error('Token is not within any existing sentence');
      }

      // Check if this is the first token in the sentence
      if (token.begin === containingSentence.begin) {
        notifications.show({
          title: 'Cannot split here',
          message: 'Cannot create a new sentence at the first token of a sentence',
          color: 'yellow'
        });
        return;
      }

      // Perform the API call
      client.beginBatch();

      // Update the existing sentence to end at the token's position
      client.tokens.update(
        containingSentence.id,
        containingSentence.begin,
        token.begin
      );

      // Create a new sentence token starting at this token's position
      await client.tokens.create(
        sentenceTokenLayer.id,
        textId,
        token.begin,
        containingSentence.end
      );

      await client.submitBatch();

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      handleStrictModeError(error, 'Create sentence boundary');
    }
  }, [findSentenceForToken, sentenceTokenLayer, textId, client, onTokenizationComplete, handleStrictModeError]);

  // Handle sentence deletion
  const handleDeleteSentence = useCallback(async (sentence) => {
    try {
      // Use O(1) lookup instead of findIndex
      const sentenceIndex = sentenceIndexLookup?.get(sentence.id);

      if (sentenceIndex === undefined) {
        throw new Error('Sentence not found');
      }

      // Can't delete the first sentence (no previous sentence to expand)
      if (sentenceIndex === 0) {
        throw new Error('Cannot delete the first sentence');
      }

      const previousSentence = sortedSentences[sentenceIndex - 1];

      // Perform the API call
      client.beginBatch();

      // Expand the previous sentence to cover the deleted sentence's range
      client.tokens.update(
        previousSentence.id,
        previousSentence.begin,
        sentence.end
      );

      // Delete the sentence
      client.tokens.delete(sentence.id);

      await client.submitBatch();

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      handleStrictModeError(error, 'Delete sentence boundary');
    }
  }, [sentenceIndexLookup, sortedSentences, client, onTokenizationComplete, handleStrictModeError]);

  // Handle right-click token deletion
  const handleTokenRightClick = useCallback(async (token, event) => {
    event.preventDefault();

    try {
      // Perform the API call
      await client.tokens.delete(token.id);

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      handleStrictModeError(error, 'Delete token');
    }
  }, [client, onTokenizationComplete, handleStrictModeError]);

  // Handle token drag selection
  const handleTokenDragStart = useCallback((token, event) => {
    if (event.ctrlKey || event.metaKey) return; // Don't start drag on ctrl/cmd+click (sentence creation)

    setIsTokenDragging(true);
    setDragStartToken(token);
    setSelectedTokens(new Set([token.id]));
  }, []);

  const handleTokenDragEnter = useCallback((token) => {
    if (!isTokenDragging || !dragStartToken || !tokenPositionMaps) return;

    // Only select tokens within the same sentence
    const startSentence = findSentenceForToken ? findSentenceForToken(dragStartToken) : null;
    const currentSentence = findSentenceForToken ? findSentenceForToken(token) : null;

    if (!startSentence || !currentSentence || startSentence.id !== currentSentence.id) {
      return; // Different sentences, don't select
    }

    // Use O(1) position lookups instead of findIndex
    const tokenPositionMap = tokenPositionMaps.get(startSentence.id);
    if (!tokenPositionMap) return;

    const startIndex = tokenPositionMap.get(dragStartToken.id);
    const endIndex = tokenPositionMap.get(token.id);

    if (startIndex === undefined || endIndex === undefined) return;

    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);

    // Tokens are already sorted in the sentence, so we can access them directly
    const sentenceTokens = startSentence.tokens || [];
    const newSelectedTokens = new Set();
    for (let i = minIndex; i <= maxIndex; i++) {
      if (sentenceTokens[i]) {
        newSelectedTokens.add(sentenceTokens[i].id);
      }
    }

    setSelectedTokens(newSelectedTokens);
  }, [isTokenDragging, dragStartToken, findSentenceForToken, tokenPositionMaps]);

  const handleTokenDragEnd = useCallback(async () => {
    if (!isTokenDragging || selectedTokens.size <= 1 || !tokenLookup) {
      setIsTokenDragging(false);
      setSelectedTokens(new Set());
      setDragStartToken(null);
      return;
    }

    try {
      // Use O(1) lookups instead of filtering all tokens
      const tokensToMerge = Array.from(selectedTokens)
        .map(tokenId => tokenLookup.get(tokenId))
        .filter(token => token) // Remove any undefined tokens
        .sort((a, b) => a.begin - b.begin);

      if (tokensToMerge.length <= 1) return;

      const firstToken = tokensToMerge[0];
      const lastToken = tokensToMerge[tokensToMerge.length - 1];
      const tokensToDelete = tokensToMerge.slice(1);

      // Perform the API call
      client.beginBatch();

      // Expand the first token to cover the entire range
      client.tokens.update(
        firstToken.id,
        firstToken.begin,
        lastToken.end
      );

      // Delete all other tokens
      for (let i = 1; i < tokensToMerge.length; i++) {
        client.tokens.delete(tokensToMerge[i].id);
      }

      await client.submitBatch();

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      handleStrictModeError(error, 'Merge tokens');
    } finally {
      setIsTokenDragging(false);
      setSelectedTokens(new Set());
      setDragStartToken(null);
    }
  }, [isTokenDragging, selectedTokens, tokenLookup, client, onTokenizationComplete, handleStrictModeError]);

  // Add global mouse event listeners for dragging
  useEffect(() => {
    if (isTokenDragging) {
      const handleGlobalMouseUp = () => {
        handleTokenDragEnd();
      };

      window.document.addEventListener('mouseup', handleGlobalMouseUp);
      return () => {
        window.document.removeEventListener('mouseup', handleGlobalMouseUp);
      };
    }
  }, [isTokenDragging, handleTokenDragEnd]);

  // Handle starting token splitting
  const handleTokenSplitStart = useCallback((token) => {
    // Don't allow splitting tokens with fewer than 2 characters
    const tokenText = text.slice(token.begin, token.end);
    if (tokenText.length < 2) {
      return;
    }

    // If clicking on another token while one is already being split, switch to the new one
    setSplittingToken(token);
    setHoveredSplitPosition(null);
  }, [text]);

  // Handle token splitting at character position
  const handleTokenSplit = useCallback(async (token, splitPosition) => {
    try {
      const tokenText = token.content || text.slice(token.begin, token.end);
      const actualSplitPosition = token.begin + splitPosition;

      // Get the text for both parts
      const leftText = text.slice(token.begin, actualSplitPosition);
      const rightText = text.slice(actualSplitPosition, token.end);

      // Trim whitespace from both parts
      const leftTrimmed = leftText.trimEnd();
      const rightTrimmed = rightText.trimStart();

      // Calculate new boundaries after trimming
      const leftEnd = token.begin + leftTrimmed.length;
      const rightStart = token.end - rightTrimmed.length;

      // Perform the API call
      client.beginBatch();

      // Only update/create tokens if they have content after trimming
      if (leftTrimmed.length > 0) {
        // Update the original token to end at the trimmed position
        client.tokens.update(
          token.id,
          token.begin,
          leftEnd
        );
      } else {
        // If left part is empty after trimming, delete the original token
        client.tokens.delete(token.id);
      }

      if (rightTrimmed.length > 0) {
        // Create a new token for the remaining part (trimmed)
        client.tokens.create(
          primaryTokenLayer.id,
          textId,
          rightStart,
          token.end
        );
      }

      await client.submitBatch();

      // Clear splitting state after successful API call
      setSplittingToken(null);
      setHoveredSplitPosition(null);

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      handleStrictModeError(error, 'Split token');
      // Clear splitting state on error too
      setSplittingToken(null);
      setHoveredSplitPosition(null);
    }
  }, [text, primaryTokenLayer, textId, client, onTokenizationComplete, handleStrictModeError]);

  // Handle text selection on untokenized text
  const handleTextSelection = useCallback(async (event) => {
    const selection = window.getSelection();

    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();

    if (!selectedText) {
      return;
    }

    // Find the parent span with data attributes by traversing up the DOM
    let spanElement = event.target;
    while (spanElement && !spanElement.hasAttribute('data-begin')) {
      spanElement = spanElement.parentElement;
    }

    if (!spanElement) {
      return;
    }

    // Get the span's data attributes that should contain begin/end positions
    const spanBegin = parseInt(spanElement.getAttribute('data-begin'), 10);
    const spanEnd = parseInt(spanElement.getAttribute('data-end'), 10);

    if (isNaN(spanBegin) || isNaN(spanEnd)) {
      return;
    }

    try {
      // Calculate the actual selection offset within the span using Range API
      const spanRange = window.document.createRange();
      spanRange.setStart(spanElement.firstChild || spanElement, 0);
      spanRange.setEnd(range.startContainer, range.startOffset);

      const selectionStart = spanRange.toString().length;
      const selectionLength = selectedText.length;

      // Validate that the selection is within the span bounds
      if (selectionStart < 0 || selectionStart + selectionLength > spanElement.textContent.length) {
        return;
      }

      const actualStart = spanBegin + selectionStart;
      const actualEnd = actualStart + selectionLength;

      if (actualEnd <= actualStart) {
        return;
      }

      // Create a new token for the selected range
      await client.tokens.create(
        primaryTokenLayer.id,
        textId,
        actualStart,
        actualEnd
      );

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      handleStrictModeError(error, 'Create token from selection');
    } finally {
      // Always clear the selection, whether successful or not
      selection.removeAllRanges();
    }
  }, [primaryTokenLayer, textId, client, onTokenizationComplete, handleStrictModeError]);


  // Get sentences from parsed document
  const sentences = parsedDocument?.sentences || [];

  // Memoize pagination calculations
  const paginationData = useMemo(() => {
    const totalPages = Math.ceil(sentences.length / sentencesPerPage);
    const startIndex = (currentPage - 1) * sentencesPerPage;
    const endIndex = startIndex + sentencesPerPage;
    const currentPageSentences = sentences.slice(startIndex, endIndex);
    
    return { totalPages, startIndex, endIndex, currentPageSentences };
  }, [sentences, currentPage, sentencesPerPage]);

  const { totalPages, startIndex, endIndex, currentPageSentences } = paginationData;

  // Reset to page 1 if current page is out of bounds
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(1);
    }
  }, [currentPage, totalPages]);

  // Create a visual representation of the text with tokens organized by sentences
  const renderTextWithTokens = () => {
    if (!text) return null;

    if (sentences.length === 0) {
      // No sentences yet, render as before with all tokens
      const allTokens = [...existingTokens].sort((a, b) => a.begin - b.begin);
      const spans = [];
      let lastEnd = 0;

      for (const token of allTokens) {
        // Add untokenized text before this token
        if (token.begin > lastEnd) {
          spans.push({
            text: text.slice(lastEnd, token.begin),
            isToken: false,
            begin: lastEnd,
            end: token.begin
          });
        }

        // Add the token - use existing content
        spans.push({
          ...token,
          isToken: true,
          begin: token.begin,
          end: token.end
        });

        lastEnd = token.end;
      }

      // Add final untokenized text
      if (lastEnd < text.length) {
        spans.push({
          text: text.slice(lastEnd),
          isToken: false,
          begin: lastEnd,
          end: text.length
        });
      }

      return (
        <Box p="md" style={{
          lineHeight: 1.6,
          fontFamily: 'monospace',
          fontSize: '14px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}>
          {spans.map((span, index) =>
            span.isToken ? (
              <TokenComponent
                key={span.id ? `token-${span.id}` : `token-span-${span.begin}-${span.end}`}
                span={span}
                text={text}
                onTokenClick={handleTokenClick}
                onTokenRightClick={handleTokenRightClick}
                onTokenSplit={handleTokenSplitStart}
                onTokenDragStart={handleTokenDragStart}
                onTokenDragEnter={handleTokenDragEnter}
                isSelected={selectedTokens.has(span.id)}
                isTokenDragging={isTokenDragging}
                isSplitting={splittingToken?.id === span.id}
                hoveredSplitPosition={hoveredSplitPosition}
                setHoveredSplitPosition={setHoveredSplitPosition}
                handleTokenSplit={handleTokenSplit}
              />
            ) : (
              <span
                key={`text-${span.begin}-${span.end}`}
                data-begin={span.begin}
                data-end={span.end}
                style={{
                  cursor: 'text',
                  userSelect: 'text'
                }}
                onMouseUp={handleTextSelection}
                title="Select text to create token"
              >
                <TextWithVisibleWhitespace text={span.text} />
              </span>
            )
          )}
        </Box>
      );
    }

    // Render with sentences - using pre-computed spans from parser
    return (
      <Box style={{
        lineHeight: 1.6,
        fontFamily: 'monospace',
        fontSize: '14px',
      }}>
        {currentPageSentences.map((sentence, pageIndex) => {
          // Calculate the actual sentence index in the full document
          const actualSentenceIndex = startIndex + pageIndex;
          
          return (
            <SentenceComponent
              key={`sentence-${sentence.id}`}
              sentence={sentence}
              sentenceIndex={actualSentenceIndex}
              text={text}
              handleDeleteSentence={handleDeleteSentence}
              handleTokenClick={handleTokenClick}
              handleTokenRightClick={handleTokenRightClick}
              handleTokenSplitStart={handleTokenSplitStart}
              handleTokenDragStart={handleTokenDragStart}
              handleTokenDragEnter={handleTokenDragEnter}
              handleTextSelection={handleTextSelection}
              handleTokenSplit={handleTokenSplit}
              selectedTokens={selectedTokens}
              isTokenDragging={isTokenDragging}
              splittingToken={splittingToken}
              hoveredSplitPosition={hoveredSplitPosition}
              setHoveredSplitPosition={setHoveredSplitPosition}
            />
          );
        })}
      </Box>
    );
  }

  // Handle algorithm dropdown click to discover services
  const handleAlgorithmDropdownClick = useCallback(async () => {
    if (!project?.id || isDiscovering) return;
    await discoverServices(project.id);
  }, [project?.id, isDiscovering, discoverServices]);

  // Discover services on component mount
  useEffect(() => {
    if (project?.id) {
      discoverServices(project.id);
    }
  }, [project?.id, discoverServices]);

  // Populate tokenization options when available services change
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

    setAlgorithmOptions(options);
  }, [availableServices]);

  // Restore cached selection when options are available
  useEffect(() => {
    // Wait for service discovery and only run once
    if (algorithmOptions.length <= 1 || hasRestoredCache) return;

    const cached = localStorage.getItem('plaid_tokenization_algorithm');
    const isAvailable = cached && algorithmOptions.some(opt => opt.value === cached);

    if (isAvailable) {
      setAlgorithm(cached);
    } else {
      if (cached) localStorage.removeItem('plaid_tokenization_algorithm');
      setAlgorithm('rule-based-punctuation');
    }

    setHasRestoredCache(true);
  }, [algorithmOptions, hasRestoredCache]);

  const handleTokenize = async () => {
    setIsTokenizing(true);
    setTokenizationProgress(0);

    try {
      // Check if using an NLP service
      if (algorithm.startsWith('service:')) {
        const serviceId = algorithm.substring(8); // Remove 'service:' prefix

        updateProgress(10, 'Requesting tokenization from NLP service...');

        await requestService(
          project.id,
          document.id,
          serviceId,
          {
            documentId: document.id,
            textLayerId: primaryTextLayer?.id,
            primaryTokenLayerId: primaryTokenLayer.id,
            sentenceLayerId: sentenceTokenLayer?.id
          },
          {
            successTitle: 'Tokenization Complete',
            successMessage: 'Document has been tokenized successfully',
            errorTitle: 'Tokenization Failed',
            errorMessage: 'An error occurred during tokenization'
          }
        );

        updateProgress(100, 'Tokenization complete!');

        if (onTokenizationComplete) {
          onTokenizationComplete();
        }

        return;
      }

      // Otherwise use built-in tokenization
      // Tokenize words only
      updateProgress(25, 'Analyzing text for tokens...');
      const untokenizedRanges = findUntokenizedRanges(text, existingTokens);
      const newTokens = tokenizeText(text, ignoredTokensConfig, untokenizedRanges);

      updateProgress(50, 'Validating tokenization...');
      let validation = validateTokenization(newTokens, text);
      if (!validation.isValid) {
        throw new Error(`Tokenization validation failed: ${validation.errors.join(', ')}`);
      }

      if (newTokens.length > 0) {
        updateProgress(75, 'Creating tokens...');
        const tokenCreationRequests = newTokens.map(token => ({
          tokenLayerId: primaryTokenLayer.id,
          text: textId,
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

      if (onTokenizationComplete) {
        onTokenizationComplete();
      }

    } catch (error) {
      console.error('Tokenization failed:', error);
      notifications.show({
        title: 'Tokenization Failed',
        message: error.message || 'An error occurred during tokenization',
        color: 'red'
      });
    } finally {
      setIsTokenizing(false);
      setTokenizationProgress(0);
      setCurrentOperation('');
    }
  };


  // Pagination component
  const PaginationControls = () => {
    if (sentences.length === 0) return null;

    return (
      <Group justify="space-between" align="center" p="sm" style={{ borderBottom: '1px solid #e0e0e0' }}>
        <Text size="sm" c="dimmed">
          Showing sentences {startIndex + 1}-{Math.min(endIndex, sentences.length)} of {sentences.length}
        </Text>
        <Pagination
          value={currentPage}
          onChange={setCurrentPage}
          total={totalPages}
          size="sm"
          withEdges
        />
      </Group>
    );
  };

  return (
    <Stack spacing="lg" mt="md" style={{ height: 'calc(100vh - 200px)' }}>
      {/* Text Visualization */}
      <Paper withBorder style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Box p="md" style={{ borderBottom: '1px solid #e0e0e0' }}>
          <Group gap="xs" align="center">
            <Title order={3}>Tokens</Title>
            <Tooltip label={helpOpened ? "Hide help" : "Show help"}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="md"
                onClick={() => setHelpOpened(!helpOpened)}
              >
                <IconQuestionMark size={20} />
              </ActionIcon>
            </Tooltip>
          </Group>

          <Collapse in={helpOpened}>
            <Text size="md" mb="sm" mt="sm">
              Existing tokens are highlighted. Untokenized text appears as plain text.
            </Text>
            <Stack gap="0.4rem" mb="xs">
              <div>
                <Kbd size="md">Left Click</Kbd> + <Kbd size="md">Drag</Kbd>: Create token from selection, or merge tokens
              </div>
              <div>
                <Kbd size="md">Left Click</Kbd>: Split Token
              </div>
              <div>
                <Kbd size="md">Esc</Kbd>: Cancel token splitting
              </div>
              <div>
                <Kbd size="md">Right Click</Kbd>: Delete Token
              </div>
              <div>
                <Kbd size="md">Ctrl</Kbd>/<Kbd size="md">Cmd</Kbd> + <Kbd size="md">Left Click</Kbd> on token: New Sentence
              </div>
              <div>
                <Kbd size="md"><IconChevronUp size={12} /></Kbd>: Merge sentence with previous
              </div>
            </Stack>
          </Collapse>
        </Box>

        {/* Top Pagination */}
        <PaginationControls />

        <Box 
          style={{ 
            flex: 1, 
            paddingLeft: '70px',
            overflowY: 'auto'
          }}
        >
          {renderTextWithTokens()}
        </Box>

        {/* Bottom Pagination */}
        <Box style={{ borderTop: '1px solid #e0e0e0' }}>
          <PaginationControls />
        </Box>
      </Paper>

      {/* Controls */}
      <Paper withBorder p="md" style={{ flexShrink: 0 }} onMouseEnter={() => discoverServices(project.id)}>
        <Group justify="space-between" align="flex-end" mb="md">
          <Group align="flex-end" gap="sm">
            <Select
                label="Tokenization Algorithm"
                value={algorithm}
                onChange={(value) => {
                  console.log('[TOK-CACHE] User selected algorithm', { value });
                  setAlgorithm(value);
                  // Cache the selection
                  if (value) {
                    console.log('[TOK-CACHE] Caching selection to localStorage', value);
                    localStorage.setItem('plaid_tokenization_algorithm', value);
                  } else {
                    console.log('[TOK-CACHE] Removing cached selection from localStorage');
                    localStorage.removeItem('plaid_tokenization_algorithm');
                  }
                }}
                data={algorithmOptions}
                style={{ width: 280 }}
                onMouseEnter={handleAlgorithmDropdownClick}
                disabled={isViewingHistorical}
            />

            <Button
                leftSection={<IconPlayerPlay size={16} />}
                onClick={handleTokenize}
                loading={isTokenizing || isProcessing}
                disabled={!text || !primaryTokenLayer || isProcessing || isViewingHistorical}
            >
              Tokenize
            </Button>
          </Group>

          <Group align="flex-end" gap="sm">
            <Button
                variant="default"
                onClick={handleClearTokens}
                disabled={isTokenizing || isProcessing || !existingTokens.length || isViewingHistorical}
            >
              Clear Tokens
            </Button>

            <Button
                variant="default"
                onClick={handleClearSentences}
                disabled={isTokenizing || isProcessing || !existingSentenceTokens.length || existingSentenceTokens.length === 1 || isViewingHistorical}
            >
              Clear Sentences
            </Button>
          </Group>
      </Group>

      {/* Progress */}
      <Paper withBorder p="md" style={{ minHeight: '120px' }}>
        {(isTokenizing || isProcessing) ? (
          <Stack spacing="sm">
            <Group>
              <IconPlayerPlay size={16} />
              <Text fw={500}>{progressMessage || 'Processing...'}</Text>
            </Group>
            <Progress value={progressPercent || tokenizationProgress} animated />
            <Text size="sm" c="dimmed">{currentOperation}</Text>
          </Stack>
        ) : (
          <Box style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Text size="sm" c="dimmed"></Text>
          </Box>
        )}
      </Paper>

      {!primaryTokenLayer && (
          <>
            <Divider mt="md" />
            <Alert icon={<IconInfoCircle size={16} />} color="red" mt="md">
              Missing primary token layer. Please ensure your project has a primary token layer configured.
            </Alert>
          </>
        )}
      </Paper>

    </Stack>
  );
};