import React, { useEffect, useState, useRef } from 'react';
import { useSnapshot } from 'valtio';
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
  Pagination, Container, Center, Loader
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconPlayerPlay from '@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs';
import IconChevronUp from '@tabler/icons-react/dist/esm/icons/IconChevronUp.mjs';
import IconCut from '@tabler/icons-react/dist/esm/icons/IconCut.mjs';
import IconQuestionMark from '@tabler/icons-react/dist/esm/icons/IconQuestionMark.mjs';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import { useTokenOperations } from './useTokenOperations.js';
import documentsStore, {loadDocument} from '../../../stores/documentsStore';
import Lazy from '../../lazy';
import './DocumentTokenize.css';


export function DocumentTokenize({ projectId, documentId, reload, client }) {
  const ops = useTokenOperations(projectId, documentId, reload, client);

  // Get the proxy once to pass down for mutations
  const docProxy = documentsStore[projectId][documentId];

  // Use snapshot for reading
  const docSnap = useSnapshot(documentsStore[projectId][documentId]);
  const uiSnap = docSnap.ui.tokenize;
  const isViewingHistorical = docSnap?.ui?.history?.viewingHistorical || false;
  const layers = docSnap.layers;
  const text = docSnap.document.text;
  const project = docSnap.project;
  const existingTokens = docSnap.sentences?.flatMap(s => s.tokens) || [];
  const existingSentenceTokens = docSnap.sentences || [];

  // Create stable callbacks for UI mutations
  const toggleHelp = () => {
    docProxy.ui.tokenize.helpOpen = !docProxy.ui.tokenize.helpOpen;
  };
  
  // Algorithm selection handler
  const handleAlgorithmChange = (value) => {
    docProxy.ui.tokenize.algorithm = value;
    // Cache the selection
    if (value) {
      localStorage.setItem('plaid_tokenization_algorithm', value);
    } else {
      localStorage.removeItem('plaid_tokenization_algorithm');
    }
  };

  // Handle algorithm dropdown click to discover services
  const handleAlgorithmDropdownClick = async () => {
    if (!project?.id || ops.isDiscovering) return;
    await ops.discoverServices(project.id);
  };

  // Handle global mouse events for drag operations
  useEffect(() => {
    const handleGlobalMouseUp = async () => {
      // Check all sentences for active drag operations
      for (const sentProxy of docProxy.sentences) {
        if (sentProxy.dragState.isDragging) {
          // Only merge if we have multiple tokens selected
          if (sentProxy.dragState.selectedTokenIds.size > 1) {
            await ops.mergeTokens(sentProxy, sentProxy.dragState.selectedTokenIds);
          }
          
          // Reset drag state for this sentence
          sentProxy.dragState.isDragging = false;
          sentProxy.dragState.startToken = null;
          sentProxy.dragState.selectedTokenIds = new Set();
        }
      }
    };

    // Always listen for mouseup when component is mounted
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [docProxy, ops]);

  return (
      <Stack spacing="lg" mt="md" style={{ height: 'calc(100vh - 200px)' }}>
        {/* Text Visualization */}
        <Paper withBorder style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <Box p="md" style={{ borderBottom: '1px solid #e0e0e0' }}>
            <Group gap="xs" align="center">
              <Title order={3}>Tokens</Title>
              <Tooltip label={uiSnap.helpOpen ? "Hide help" : "Show help"}>
                <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="md"
                    onClick={toggleHelp}
                >
                  <IconQuestionMark size={20} />
                </ActionIcon>
              </Tooltip>
            </Group>

            <Collapse in={uiSnap.helpOpen}>
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

          {/* Sentence rendering */}
          <Box className="sentence-container">
            {docProxy.sentences.map((sentProxy, index) => {
              return (
                  <SentenceComponent
                      key={docSnap.sentences[index].id}
                      sentProxy={sentProxy}
                      ops={ops}
                      index={index}
                      docProxy={docProxy}
                  />
              )})}
          </Box>
        </Paper>

        {/* NLP Controls Panel */}
        <Paper withBorder p="md" style={{ flexShrink: 0 }} onMouseEnter={() => ops.discoverServices(project?.id)}>
          <Group justify="space-between" align="flex-end" mb="md">
            <Group align="flex-end" gap="sm">
              <Select
                label="Tokenization Algorithm"
                value={uiSnap.algorithm}
                onChange={handleAlgorithmChange}
                data={uiSnap.algorithmOptions}
                style={{ width: 280 }}
                onMouseEnter={handleAlgorithmDropdownClick}
                disabled={isViewingHistorical}
              />

              <Button
                leftSection={<IconPlayerPlay size={16} />}
                onClick={ops.handleTokenize}
                loading={uiSnap.isTokenizing || ops.isProcessing}
                disabled={!text?.body || !layers?.primaryTokenLayer || ops.isProcessing || isViewingHistorical}
              >
                Tokenize
              </Button>
            </Group>

            <Group align="flex-end" gap="sm">
              <Button
                variant="default"
                onClick={ops.handleClearTokens}
                disabled={uiSnap.isTokenizing || ops.isProcessing || !existingTokens.length || isViewingHistorical}
              >
                Clear Tokens
              </Button>

              <Button
                variant="default"
                onClick={ops.handleClearSentences}
                disabled={uiSnap.isTokenizing || ops.isProcessing || !existingSentenceTokens.length || existingSentenceTokens.length === 1 || isViewingHistorical}
              >
                Clear Sentences
              </Button>
            </Group>
          </Group>

          {/* Progress */}
          <Paper withBorder p="md" style={{ minHeight: '120px' }}>
            {(uiSnap.isTokenizing || ops.isProcessing) ? (
              <Stack spacing="sm">
                <Group>
                  <IconPlayerPlay size={16} />
                  <Text fw={500}>{ops.progressMessage || 'Processing...'}</Text>
                </Group>
                <Progress value={ops.progressPercent || uiSnap.tokenizationProgress} animated />
                <Text size="sm" c="dimmed">{uiSnap.currentOperation}</Text>
              </Stack>
            ) : (
              <Box style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Text size="sm" c="dimmed"></Text>
              </Box>
            )}
          </Paper>

          {!layers?.primaryTokenLayer && (
            <>
              <Divider mt="md" />
              <Alert icon={<IconInfoCircle size={16} />} color="red" mt="md">
                Missing primary token layer. Please ensure your project has a primary token layer configured.
              </Alert>
            </>
          )}
        </Paper>
      </Stack>
  )
}

function SentenceComponent({sentProxy, ops, index, docProxy}) {
  const sentSnap = useSnapshot(sentProxy);
  const dragStateSnap = sentSnap.dragState;
  
  // Create a stable callback for merge action
  const handleMerge = async () => {
    await ops.mergeSentence(sentSnap, index, docProxy);
  };

  const preview = (
      <div style={{position: 'relative'}}>
        <div className="sentence-content">
          {sentSnap.pieces.map(p => p.content).join("")}
        </div>
        <div className="blur-overlay" />
      </div>
  );
  return (
    <Lazy className="sentence-row" contentPreview={preview}>
      <Box>
        {/* Sentence number */}
        <Text size="xs" c="dimmed" className="sentence-number">
          {index + 1}
        </Text>

        {/* Delete button - subtle, always visible (not on first sentence) */}
        {index > 0 && (
            <Box className="merge-button">
              <Tooltip label="Merge with above">
                <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="xs"
                    onClick={handleMerge}
                    className="merge-icon"
                >
                  <IconChevronUp size={12} />
                </ActionIcon>
              </Tooltip>
            </Box>
        )}

        {/* Sentence content */}
        <Box className="sentence-content">
          {sentSnap.pieces.map((piece, pieceIndex) =>
              piece.isToken ? (
                  <TokenComponent
                      key={piece.id}
                      sentSnap={sentSnap}
                      sentProxy={sentProxy}
                      sentIndex={index}
                      pieceIndex={pieceIndex}
                      ops={ops}
                      dragStateSnap={dragStateSnap}
                      docProxy={docProxy}
                  />
              ) : (
                  <span
                      key={`${piece.begin}-${piece.end}`}
                      className="untokenized"
                      onMouseUp={(e) => {
                        ops.createTokenFromSelection(e, sentProxy, piece, pieceIndex);
                      }}
                      title="Select text to create token"
                  >
                  {piece.content}
                </span>
              )
          )}
        </Box>
      </Box>
    </Lazy>
  )
}

// Memoized token component
function TokenComponent({ 
  ops,
  sentSnap,
  sentProxy,
  sentIndex,
  pieceIndex,
  dragStateSnap,
  docProxy
}) {
  const [isSplitting, setIsSplitting] = useState(false);
  const piece = sentSnap.pieces[pieceIndex];
  const isSelected = dragStateSnap.selectedTokenIds.has(piece.id);
  //console.log(`Rendering ${sentIndex}:${piece.begin}-end`)

  const handleClick = async (e) => {
    // Don't trigger anything if we're dragging
    if (dragStateSnap.isDragging) return;
    
    // Handle Ctrl/Cmd+click for sentence splitting
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (pieceIndex > 0) {
        await ops.splitSentence(piece, sentProxy, docProxy);
      }
      return;
    }
    
    // Regular click for token splitting
    if (piece.content.length > 1) {
      setIsSplitting(true);
    }
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return; // Only handle left click
    e.preventDefault();
    
    // Start drag operation on this sentence
    sentProxy.dragState.isDragging = true;
    sentProxy.dragState.startToken = {
      id: piece.id,
      sentenceId: sentSnap.id,
      begin: piece.begin,
      end: piece.end
    };
    sentProxy.dragState.selectedTokenIds = new Set([piece.id]);
  };

  const handleMouseEnter = () => {
    if (!dragStateSnap.isDragging || !dragStateSnap.startToken) return;

    // Find all tokens between start and current
    const startBegin = dragStateSnap.startToken.begin;
    const currentBegin = piece.begin;
    const minBegin = Math.min(startBegin, currentBegin);
    const maxEnd = Math.max(dragStateSnap.startToken.end, piece.end);
    
    const newSelectedIds = new Set();
    sentSnap.pieces.forEach(p => {
      if (p.isToken && p.begin >= minBegin && p.end <= maxEnd) {
        newSelectedIds.add(p.id);
      }
    });
    
    sentProxy.dragState.selectedTokenIds = newSelectedIds;
  };

  const handleRightClick = async (e) => {
    e.preventDefault();
    await ops.deleteToken(sentProxy, sentIndex, piece, pieceIndex);
  };

  const close = () => {
    setIsSplitting(false);
  };

  if (isSplitting) {
    return (
        <TokenSplitter
            sentProxy={sentProxy}
            ops={ops}
            piece={piece}
            pieceIndex={pieceIndex}
            close={close}
        />
    );
  }

  return (
      <Box
          component="span"
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onMouseEnter={handleMouseEnter}
          onContextMenu={handleRightClick}
          className={`token ${dragStateSnap.isDragging ? 'token-dragging' : ''}`}
          style={{
            backgroundColor: isSelected ? "#1976d2" : "#e3f2fd",
            color: isSelected ? "white" : "inherit",
            border: `1px solid ${isSelected ? "#1565c0" : "#bbdefb"}`,
            cursor: dragStateSnap.isDragging ? 'grabbing' : 'pointer'
          }}
      >
        {piece.content}
      </Box>
  );
}

// Token splitter component
function TokenSplitter({ ops, piece: token, pieceIndex, sentProxy, close }) {
  async function handleTokenSplit(e, wordOffset) {
    e.stopPropagation();
    close();
    await ops.splitToken(token.id, sentProxy, token, pieceIndex, wordOffset);
  }

  return (
      <Box
          component="span"
          className="splitter-box"
          onMouseLeave={close}
      >
        {Array.from(token.content).map((char, index) => (
            <Box key={token.begin + index} className="splitter-char-container">
              <Text className="splitter-char">{char}</Text>
              {index < Array.from(token.content).length - 1 && (
                  <Box
                      className="splitter-split-point"
                      onClick={(e) => handleTokenSplit(e, index)}
                  >
                    <IconCut className="splitter-icon" size={12}/>
                  </Box>
              )}
            </Box>
        ))}
      </Box>
  );
}