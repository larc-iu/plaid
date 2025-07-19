import { useState, useMemo } from 'react';
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
  Modal
} from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import IconChevronUp from '@tabler/icons-react/dist/esm/icons/IconChevronUp.mjs';
import IconCut from '@tabler/icons-react/dist/esm/icons/IconCut.mjs';
import { notifications } from '@mantine/notifications';
import {
  tokenizeText,
  findUntokenizedRanges,
  getIgnoredTokensConfig,
  validateTokenization
} from '../../utils/tokenizationUtils';

// Individual token component - simplified without inline editing
const TokenComponent = ({ 
  span, 
  text, 
  onTokenClick, 
  onTokenRightClick, 
  onTokenSplit,
  onTokenDragStart,
  onTokenDragEnter,
  onTokenDragEnd,
  isSelected,
  isTokenDragging
}) => {
  return (
    <Box
      component="span"
      onClick={(e) => {
        if (e.ctrlKey) {
          onTokenClick(span, e);
        } else {
          onTokenSplit(span);
        }
      }}
      onContextMenu={(e) => onTokenRightClick(span, e)}
      onMouseDown={(e) => {
        if (!e.ctrlKey) {
          onTokenDragStart(span, e);
        }
      }}
      onMouseEnter={(e) => {
        if (isTokenDragging) {
          onTokenDragEnter(span);
        }
      }}
      onMouseUp={onTokenDragEnd}
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
      {span.text}
    </Box>
  );
};

export const DocumentTokenize = ({ document, parsedDocument, project, client, onTokenizationComplete }) => {
  const [isTokenizing, setIsTokenizing] = useState(false);
  const [tokenizationProgress, setTokenizationProgress] = useState(0);
  const [currentOperation, setCurrentOperation] = useState('');
  const [algorithm, setAlgorithm] = useState('rule-based-punctuation');
  const [hoveredSentence, setHoveredSentence] = useState(null);
  
  // Drag selection state (for untokenized text)
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  
  // Token drag selection state
  const [isTokenDragging, setIsTokenDragging] = useState(false);
  const [selectedTokens, setSelectedTokens] = useState(new Set());
  const [dragStartToken, setDragStartToken] = useState(null);
  
  // Token splitting modal state
  const [modalOpened, setModalOpened] = useState(false);
  const [modalToken, setModalToken] = useState(null);
  const [hoveredSplitPosition, setHoveredSplitPosition] = useState(null);

  // Get layer information
  const primaryTextLayer = project?.textLayers?.find(layer => layer.config?.flan?.primary);
  const primaryTokenLayer = primaryTextLayer?.tokenLayers?.find(layer => layer.config?.flan?.primary);
  const sentenceTokenLayer = primaryTextLayer?.tokenLayers?.find(layer => layer.config?.flan?.sentence);
  
  const text = parsedDocument?.document?.text?.body || '';
  const existingTokens = parsedDocument?.sentences?.flatMap(s => s.tokens) || [];
  const existingSentenceTokens = parsedDocument?.sentences || [];
  
  // Get text ID from document structure
  const textId = document?.textLayers?.find(layer => layer.config?.flan?.primary)?.text?.id;
  
  const ignoredTokensConfig = getIgnoredTokensConfig(project);

  const updateProgress = (percent, operation) => {
    setTokenizationProgress(percent);
    setCurrentOperation(operation);
  };

  // Handle CTRL+click on token to create new sentence
  const handleTokenClick = async (token, event) => {
    if (!event.ctrlKey) return;
    
    event.preventDefault();
    
    try {
      // Find the sentence that contains this token
      const containingSentence = existingSentenceTokens.find(sentence => 
        token.begin >= sentence.begin && token.end <= sentence.end
      );
      
      if (!containingSentence) {
        throw new Error('Token is not within any existing sentence');
      }

      // Use a batch so that these two changes occur atomically
      client.beginBatch()

      // Update the existing sentence to end at the token's position
      client.tokens.update(
        containingSentence.id,
        containingSentence.begin,
        token.begin // Shrink to end at the new boundary
      );
      
      // Create a new sentence token starting at this token's position
      client.tokens.create(
        sentenceTokenLayer.id,
        textId,
        token.begin,
        containingSentence.end // Extend to the original sentence's end
      );
      await client.submitBatch()
      
      
      if (onTokenizationComplete) {
        onTokenizationComplete();
      }
    } catch (error) {
      console.error('Failed to create sentence:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to create sentence boundary',
        color: 'red'
      });
    }
  };

  // Handle sentence deletion
  const handleDeleteSentence = async (sentence) => {
    try {
      // Find the previous sentence (the one that should expand)
      const sortedSentences = [...existingSentenceTokens].sort((a, b) => a.begin - b.begin);
      const sentenceIndex = sortedSentences.findIndex(s => s.id === sentence.id);
      
      if (sentenceIndex === -1) {
        throw new Error('Sentence not found');
      }
      
      // Can't delete the first sentence (no previous sentence to expand)
      if (sentenceIndex === 0) {
        throw new Error('Cannot delete the first sentence');
      }
      
      const previousSentence = sortedSentences[sentenceIndex - 1];
      
      // Use a batch so that these changes occur atomically
      client.beginBatch();
      
      // Expand the previous sentence to cover the deleted sentence's range
      client.tokens.update(
        previousSentence.id,
        previousSentence.begin,
        sentence.end // Extend to cover the deleted sentence
      );
      
      // Delete the sentence
      client.tokens.delete(sentence.id);
      
      await client.submitBatch();
      
      
      if (onTokenizationComplete) {
        onTokenizationComplete();
      }
    } catch (error) {
      console.error('Failed to delete sentence:', error);
      notifications.show({
        title: 'Error',
        message: error.message || 'Failed to delete sentence boundary',
        color: 'red'
      });
    }
  };

  // Handle right-click token deletion
  const handleTokenRightClick = async (token, event) => {
    event.preventDefault();
    
    try {
      await client.tokens.delete(token.id);
      
      
      if (onTokenizationComplete) {
        onTokenizationComplete();
      }
    } catch (error) {
      console.error('Failed to delete token:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to delete token',
        color: 'red'
      });
    }
  };

  // Handle token drag selection
  const handleTokenDragStart = (token, event) => {
    if (event.ctrlKey) return; // Don't start drag on ctrl+click (sentence creation)
    
    setIsTokenDragging(true);
    setDragStartToken(token);
    setSelectedTokens(new Set([token.id]));
  };

  const handleTokenDragEnter = (token) => {
    if (!isTokenDragging || !dragStartToken) return;
    
    // Only select tokens within the same sentence
    const startSentence = existingSentenceTokens.find(sentence => 
      dragStartToken.begin >= sentence.begin && dragStartToken.end <= sentence.end
    );
    const currentSentence = existingSentenceTokens.find(sentence => 
      token.begin >= sentence.begin && token.end <= sentence.end
    );
    
    if (!startSentence || !currentSentence || startSentence.id !== currentSentence.id) {
      return; // Different sentences, don't select
    }
    
    // Get all tokens in this sentence and find the range
    const sentenceTokens = startSentence.tokens || [];
    const sortedTokens = [...sentenceTokens].sort((a, b) => a.begin - b.begin);
    
    const startIndex = sortedTokens.findIndex(t => t.id === dragStartToken.id);
    const endIndex = sortedTokens.findIndex(t => t.id === token.id);
    
    if (startIndex === -1 || endIndex === -1) return;
    
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    
    const newSelectedTokens = new Set();
    for (let i = minIndex; i <= maxIndex; i++) {
      newSelectedTokens.add(sortedTokens[i].id);
    }
    
    setSelectedTokens(newSelectedTokens);
  };

  const handleTokenDragEnd = async () => {
    if (!isTokenDragging || selectedTokens.size <= 1) {
      setIsTokenDragging(false);
      setSelectedTokens(new Set());
      setDragStartToken(null);
      return;
    }
    
    try {
      // Get the selected tokens and sort by position
      const tokensToMerge = existingTokens
        .filter(token => selectedTokens.has(token.id))
        .sort((a, b) => a.begin - b.begin);
      
      if (tokensToMerge.length <= 1) return;
      
      const firstToken = tokensToMerge[0];
      const lastToken = tokensToMerge[tokensToMerge.length - 1];
      
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
      console.error('Failed to merge tokens:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to merge tokens',
        color: 'red'
      });
    } finally {
      setIsTokenDragging(false);
      setSelectedTokens(new Set());
      setDragStartToken(null);
    }
  };

  // Handle opening token splitting modal
  const handleTokenSplitModal = (token) => {
    setModalToken(token);
    setModalOpened(true);
  };

  // Handle token splitting at character position
  const handleTokenSplit = async (token, splitPosition) => {
    try {
      const tokenText = text.slice(token.begin, token.end);
      const actualSplitPosition = token.begin + splitPosition;
      
      // Use a batch so that these changes occur atomically
      client.beginBatch();
      
      // Update the original token to end at the split position
      client.tokens.update(
        token.id,
        token.begin,
        actualSplitPosition
      );
      
      // Create a new token for the remaining part
      client.tokens.create(
        primaryTokenLayer.id,
        textId,
        actualSplitPosition,
        token.end
      );
      
      await client.submitBatch();
      
      // Close modal
      setModalOpened(false);
      setModalToken(null);
      setHoveredSplitPosition(null);
      
      if (onTokenizationComplete) {
        onTokenizationComplete();
      }
    } catch (error) {
      console.error('Failed to split token:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to split token',
        color: 'red'
      });
    }
  };

  // Handle drag selection on untokenized text
  const handleDragStart = (event, span) => {
    if (span.isToken) return; // Only drag on untokenized text
    
    // Calculate character-level position within the span
    const spanElement = event.target;
    const rect = spanElement.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const spanWidth = rect.width;
    const spanText = span.text;
    
    // Estimate character position based on click position
    const charPosition = Math.round((clickX / spanWidth) * spanText.length);
    const actualPosition = span.begin + Math.max(0, Math.min(charPosition, spanText.length));
    
    setIsDragging(true);
    setDragStart(actualPosition);
    setDragEnd(actualPosition);
  };

  const handleDragMove = (event, span) => {
    if (!isDragging || span.isToken) return;
    
    // Calculate character-level position within the span for drag end
    const spanElement = event.target;
    const rect = spanElement.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const spanWidth = rect.width;
    const spanText = span.text;
    
    // Estimate character position based on mouse position
    const charPosition = Math.round((clickX / spanWidth) * spanText.length);
    const actualPosition = span.begin + Math.max(0, Math.min(charPosition, spanText.length));
    
    setDragEnd(actualPosition);
  };

  const handleDragEnd = async (event, span) => {
    if (!isDragging || !dragStart || dragEnd === null) {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
      return;
    }
    
    try {
      const start = Math.min(dragStart, dragEnd);
      const end = Math.max(dragStart, dragEnd);
      
      if (end - start < 1) {
        throw new Error('Selection too small');
      }
      
      // Create a new token for the selected range
      await client.tokens.create(
        primaryTokenLayer.id,
        textId,
        start,
        end
      );
      
      if (onTokenizationComplete) {
        onTokenizationComplete();
      }
    } catch (error) {
      console.error('Failed to create token:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to create token from selection',
        color: 'red'
      });
    } finally {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
    }
  };


  // Create a visual representation of the text with tokens organized by sentences
  const renderTextWithTokens = useMemo(() => {
    if (!text) return null;

    const sentences = parsedDocument?.sentences || [];
    
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

        // Add the token (extract text content using begin/end indices)
        spans.push({
          text: text.slice(token.begin, token.end),
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
                key={`token-${span.id || span.begin}-${span.end}`}
                span={span}
                text={text}
                onTokenClick={handleTokenClick}
                onTokenRightClick={handleTokenRightClick}
                onTokenSplit={handleTokenSplitModal}
                onTokenDragStart={handleTokenDragStart}
                onTokenDragEnter={handleTokenDragEnter}
                onTokenDragEnd={handleTokenDragEnd}
                isSelected={selectedTokens.has(span.id)}
                isTokenDragging={isTokenDragging}
              />
            ) : (
              <span 
                key={`text-${span.begin}-${span.end}`}
                style={{
                  cursor: 'text',
                  userSelect: 'text'
                }}
                onMouseDown={(e) => handleDragStart(e, span)}
                onMouseMove={(e) => handleDragMove(e, span)}
                onMouseUp={(e) => handleDragEnd(e, span)}
                title="Drag to select and create token"
              >
                {span.text}
              </span>
            )
          )}
        </Box>
      );
    }

    // Render sentences on separate lines
    return (
      <Box style={{ 
        lineHeight: 1.6, 
        fontFamily: 'monospace',
        fontSize: '14px'
      }}>
        {sentences.map((sentence, sentenceIndex) => (
          <Box 
            key={`sentence-${sentence.id || sentence.begin}-${sentence.end}`}
            style={{ 
              position: 'relative',
              display: 'flex',
              alignItems: 'flex-start',
              backgroundColor: sentenceIndex % 2 === 0 ? '#ffffff' : '#f8faff',
              padding: '8px 12px',
              marginLeft: '-70px',
              marginRight: '-12px'
            }}
            onMouseEnter={() => setHoveredSentence(sentence.id || `${sentence.begin}-${sentence.end}`)}
            onMouseLeave={() => setHoveredSentence(null)}
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
            
            {/* Delete button - appears on hover (not on first sentence) */}
            {sentenceIndex > 0 && (
              <Box
                style={{
                  position: 'absolute',
                  left: '47px',
                  top: '8px',
                  opacity: hoveredSentence === (sentence.id || `${sentence.begin}-${sentence.end}`) ? 1 : 0,
                  transition: 'opacity 0.2s ease',
                  zIndex: 10
                }}
              >
                <Tooltip label="Delete sentence boundary">
                  <ActionIcon
                    variant="filled"
                    color="red"
                    size="sm"
                    onClick={() => handleDeleteSentence(sentence)}
                    style={{ boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}
                  >
                    <IconChevronUp size={14} />
                  </ActionIcon>
                </Tooltip>
              </Box>
            )}
            
            {/* Sentence content */}
            <Box style={{ flex: 1, paddingLeft: '70px' }}>
              {/* Render tokens and untokenized text within this sentence */}
              {(() => {
                const sentenceTokens = sentence.tokens || [];
                const sortedTokens = [...sentenceTokens].sort((a, b) => a.begin - b.begin);
                const spans = [];
                let lastEnd = sentence.begin;

                // Create spans for tokens and gaps within this sentence
                for (const token of sortedTokens) {
                  // Add untokenized text before this token
                  if (token.begin > lastEnd) {
                    spans.push({
                      text: text.slice(lastEnd, token.begin),
                      isToken: false,
                      begin: lastEnd,
                      end: token.begin
                    });
                  }

                  // Add the token
                  spans.push({
                    ...token,
                    text: text.slice(token.begin, token.end),
                    isToken: true
                  });

                  lastEnd = token.end;
                }

                // Add final untokenized text within sentence
                if (lastEnd < sentence.end) {
                  spans.push({
                    text: text.slice(lastEnd, sentence.end),
                    isToken: false,
                    begin: lastEnd,
                    end: sentence.end
                  });
                }

                return spans.map((span, spanIndex) => 
                  span.isToken ? (
                    <TokenComponent
                      key={`token-${span.id || span.begin}-${span.end}`}
                      span={span}
                      text={text}
                      onTokenClick={handleTokenClick}
                      onTokenRightClick={handleTokenRightClick}
                      onTokenSplit={handleTokenSplitModal}
                      onTokenDragStart={handleTokenDragStart}
                      onTokenDragEnter={handleTokenDragEnter}
                      onTokenDragEnd={handleTokenDragEnd}
                      isSelected={selectedTokens.has(span.id)}
                      isTokenDragging={isTokenDragging}
                    />
                  ) : (
                    <span
                      key={`text-${span.begin}-${span.end}`}
                      style={{
                        cursor: 'text',
                        userSelect: 'text'
                      }}
                      onMouseDown={(e) => handleDragStart(e, span)}
                      onMouseMove={(e) => handleDragMove(e, span)}
                      onMouseUp={(e) => handleDragEnd(e, span)}
                      title="Drag to select and create token"
                    >
                      {span.text}
                    </span>
                  )
                );
              })()}
            </Box>
          </Box>
        ))}
      </Box>
    );
  }, [text, parsedDocument?.sentences, existingTokens, isDragging, dragStart, dragEnd, hoveredSentence, hoveredSplitPosition, selectedTokens, isTokenDragging]);

  const handleTokenize = async () => {
    setIsTokenizing(true);
    setTokenizationProgress(0);

    try {
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

  const untokenizedRanges = findUntokenizedRanges(text, existingTokens);
  const untokenizedCharCount = untokenizedRanges.reduce((sum, range) => sum + (range.end - range.start), 0);

  return (
    <Stack spacing="lg" mt="md" style={{ height: 'calc(100vh - 200px)' }}>
      {/* Text Visualization */}
      <Paper withBorder style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Box p="md" style={{ borderBottom: '1px solid #e0e0e0', flexShrink: 0 }}>
          <Text fw={500} mb="xs">Text with Tokens</Text>
          <Text size="sm" c="dimmed" mb="sm">
            Existing tokens are highlighted. Untokenized text appears as plain text.
          </Text>
          <Stack gap="0.4rem" mb="xs">
            <div>
              <Kbd size="md">Left Click</Kbd>: <Text component="span" size="sm" c="dimmed">Split Token</Text>
            </div>
            <div>
              <Kbd size="md">Right Click</Kbd>: <Text component="span" size="sm" c="dimmed">Delete Token</Text>
            </div>

            <div>
              <Kbd size="md">Ctrl</Kbd> + <Kbd size="md">Left Click</Kbd>: <Text component="span" size="sm" c="dimmed">New Sentence</Text>
            </div>
            <div>
              <Kbd size="md">Left Click</Kbd> + <Kbd size="md">Drag</Kbd>: <Text component="span" size="sm" c="dimmed">Create token from selection, or merge tokens</Text>
            </div>
            <div>
              <Kbd size="md">Hover</Kbd>: <Text component="span" size="sm" c="dimmed">Delete Sentence</Text>
            </div>
          </Stack>
        </Box>
        
        <Box style={{ flex: 1, overflowY: 'auto', paddingLeft: '70px' }}>
          {renderTextWithTokens}
        </Box>
      </Paper>

      {/* Progress */}
      {isTokenizing && (
        <Paper withBorder p="md">
          <Stack spacing="sm">
            <Group>
              <IconPlayerPlay size={16} />
              <Text fw={500}>Processing...</Text>
            </Group>
            <Progress value={tokenizationProgress} animated />
            <Text size="sm" c="dimmed">{currentOperation}</Text>
          </Stack>
        </Paper>
      )}

      {/* Controls */}
      <Paper withBorder p="md" style={{ flexShrink: 0 }}>
        <Group justify="space-between" align="flex-end">
          <Select
            label="Tokenization Algorithm"
            value={algorithm}
            onChange={setAlgorithm}
            data={[
              { value: 'rule-based-punctuation', label: 'Rule-based Punctuation' }
            ]}
            style={{ flex: 1, maxWidth: 300 }}
          />
          
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            onClick={handleTokenize}
            loading={isTokenizing}
            disabled={!text || !primaryTokenLayer}
          >
            Tokenize
          </Button>
        </Group>

        {!primaryTokenLayer && (
          <>
            <Divider mt="md" />
            <Alert icon={<IconInfoCircle size={16} />} color="red" mt="md">
              Missing primary token layer. Please ensure your project has a primary token layer configured.
            </Alert>
          </>
        )}
      </Paper>

      {/* Token Splitting Modal */}
      <Modal
        opened={modalOpened}
        onClose={() => {
          setModalOpened(false);
          setModalToken(null);
          setHoveredSplitPosition(null);
        }}
        title="Split Token"
        centered
        size="auto"
      >
        {modalToken && (
          <Stack spacing="md">
            <Text size="sm" c="dimmed">
              Click between characters to split the token:
            </Text>
            
            <Box style={{ 
              display: 'flex', 
              alignItems: 'center',
              gap: '2px',
              padding: '10px',
              backgroundColor: '#f8f9fa',
              borderRadius: '8px',
              justifyContent: 'center'
            }}>
              {Array.from(text.slice(modalToken.begin, modalToken.end)).map((char, index) => (
                <Box key={`modal-char-${modalToken.begin}-${index}`} style={{ display: 'flex', alignItems: 'center' }}>
                  <Text 
                    style={{ 
                      fontFamily: 'monospace',
                      backgroundColor: '#fff',
                      padding: '4px 6px',
                      borderRadius: '4px',
                      minWidth: '20px',
                      textAlign: 'center',
                      fontSize: '16px',
                      border: '1px solid #dee2e6'
                    }}
                  >
                    {char === ' ' ? '·' : char}
                  </Text>
                  {index < Array.from(text.slice(modalToken.begin, modalToken.end)).length - 1 && (
                    <Box
                      style={{
                        width: '24px',
                        height: '24px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: hoveredSplitPosition === index ? 1 : 0.5,
                        transition: 'opacity 0.2s ease',
                        backgroundColor: hoveredSplitPosition === index ? '#fff5f5' : 'transparent',
                        borderRadius: '4px'
                      }}
                      onMouseEnter={() => setHoveredSplitPosition(index)}
                      onMouseLeave={() => setHoveredSplitPosition(null)}
                      onClick={() => handleTokenSplit(modalToken, index + 1)}
                    >
                      <IconCut 
                        size={14} 
                        color={hoveredSplitPosition === index ? '#e03131' : '#868e96'} 
                      />
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          </Stack>
        )}
      </Modal>

    </Stack>
  );
};