import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useSnapshot } from 'valtio';
import { 
  Stack, 
  Title, 
  Text, 
  Paper,
  Group,
  Alert,
  Divider,
  ActionIcon,
  Tooltip,
  Box
} from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconRefresh from '@tabler/icons-react/dist/esm/icons/IconRefresh.mjs';
import { useAnalyzeOperations } from './useAnalyzeOperations.js';
import { getIgnoredTokensConfig } from '../../../utils/tokenizationUtils.js';
import { VocabLinkPopover } from './VocabLinkPopover.jsx';
import documentsStore from '../../../stores/documentsStore.js';
import Lazy from '../../lazy.jsx';
import './DocumentAnalyze.css';

// Shared throttle for tab navigation across all EditableCell instances
let lastGlobalTabPress = 0;

// EditableCell component for annotation fields
const EditableCell = ({ 
  value, 
  tokenId, 
  field, 
  tabIndex, 
  onUpdate, 
  isReadOnly, 
  placeholder, 
  isSentenceLevel 
}) => {
  const [localValue, setLocalValue] = useState(value || '');
  const [isEditing, setIsEditing] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [pristineValue, setPristineValue] = useState(value || '');
  const inputRef = useRef(null);

  // Only reset local state when value changes from external source (document reload), not from our own updates
  useEffect(() => {
    if (!isEditing && !isUpdating && value !== pristineValue) {
      setLocalValue(value || '');
      setPristineValue(value || '');
    }
  }, [value]);

  const handleInput = (e) => {
    setLocalValue(e.target.textContent);
  };

  const handleBlur = async (e) => {
    setIsEditing(false);
    const newValue = (e.target.textContent || '').trim();

    // Compare against what the value was when focus was gained
    if (newValue !== pristineValue) {
      setIsUpdating(true);
      try {
        await onUpdate(newValue || "");
        // Update successful - update our baseline pristine value
        setPristineValue(newValue || '');
        setLocalValue(newValue || '');
      } catch (error) {
        setLocalValue(value || '');
        console.error('Update failed:', error);
      } finally {
        setIsUpdating(false);
      }
    }
  };

  const handleKeyDown = (e) => {
    // Throttle tab key presses to prevent browser hanging
    if (e.key === 'Tab') {
      const now = Date.now();
      if (now - lastGlobalTabPress < 55) {
        e.preventDefault();
        return;
      }
      lastGlobalTabPress = now;
    }
    
    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setLocalValue(value || '');
      setIsEditing(false);
      if (inputRef.current) {
        inputRef.current.textContent = value || '';
        inputRef.current.blur();
      }
    }
  };

  const handleFocus = () => {
    if (!isReadOnly && !isUpdating) {
      setIsEditing(true);
      // Store the value at edit start for comparison on blur
      if (inputRef.current) {
        inputRef.current.dataset.editStartValue = localValue;
      }
      setTimeout(() => {
        // Select all text content in contentEditable
        if (inputRef.current) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(inputRef.current);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }, 0);
    }
  };

  const displayValue = localValue || placeholder || '';
  const hasContent = displayValue && displayValue.trim() !== '';
  const isDisabled = isReadOnly || isUpdating;
  
  const className = `editable-field ${
    hasContent ? 'editable-field--filled' : 'editable-field--empty'
  } ${
    isDisabled ? 'editable-field--disabled' : ''
  } ${
    isUpdating ? 'editable-field--updating' : ''
  } ${
    isSentenceLevel ? 'editable-field--sentence' : ''
  }`.trim();

  // Update the div content only when not editing and when external value changes
  useEffect(() => {
    if (inputRef.current && !isEditing) {
      inputRef.current.textContent = displayValue;
    }
  }, [displayValue, isEditing]);
  
  return (
    <div
      ref={inputRef}
      id={tokenId && field ? `${tokenId}-${field}` : undefined}
      contentEditable={!isDisabled}
      onInput={handleInput}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      className={className}
      title={isDisabled ? (isUpdating ? 'Saving...' : '') : `Edit ${field || 'annotation'}`}
      tabIndex={tabIndex}
      suppressContentEditableWarning={true}
    />
  );
};

// Function to determine if a token should be ignored for annotation
const isTokenIgnored = (token, ignoredTokensConfig) => {
  if (!ignoredTokensConfig) return false;
  
  const tokenText = token.content;
  
  if (ignoredTokensConfig.type === 'unicodePunctuation') {
    const isAllPunctuation = [...tokenText].every(char => {
      return /[\p{P}\p{S}]/u.test(char);
    });
    
    if (isAllPunctuation) {
      return !ignoredTokensConfig.whitelist?.includes(tokenText);
    }
  } else if (ignoredTokensConfig.type === 'blacklist') {
    return ignoredTokensConfig.blacklist?.includes(tokenText);
  }
  
  return false;
};

// Individual sentence component with fine-grained reactivity
const SentenceRow = ({ 
  sentenceProxy, 
  sentenceIndex, 
  projectId,
  documentId,
  project, 
  vocabularies,
  operations,
  readOnly 
}) => {
  const sentenceSnap = useSnapshot(sentenceProxy);
  const ignoredTokensConfig = getIgnoredTokensConfig(project);
  
  // Extract field information from the parsed document structure
  const sentenceFields = useMemo(() => {
    if (!sentenceSnap.annotations) return [];
    // Access the store directly without subscription to avoid re-renders
    const parsedDocument = documentsStore[projectId][documentId];
    const sentenceSpanLayers = parsedDocument?.layers?.spanLayers?.sentence || [];
    
    return Object.keys(sentenceSnap.annotations).map(name => {
      const layer = sentenceSpanLayers.find(layer => layer.name === name);
      return { name, id: layer?.id || name };
    });
  }, [sentenceSnap.annotations, projectId, documentId]);
  
  const tokenFields = useMemo(() => {
    if (!sentenceSnap.tokens?.length) return [];
    const firstToken = sentenceSnap.tokens[0];
    if (!firstToken.annotations) return [];
    
    // Access the store directly without subscription to avoid re-renders
    const parsedDocument = documentsStore[projectId][documentId];
    const tokenSpanLayers = parsedDocument?.layers?.spanLayers?.token || [];

    return Object.keys(firstToken.annotations).map(name => {
      const layer = tokenSpanLayers.find(layer => layer.name === name);
      return { name, id: layer?.id || name };
    });
  }, [sentenceSnap.tokens, projectId, documentId]);
  
  const orthographyFields = useMemo(() => {
    // Access the store directly without subscription to avoid re-renders
    const parsedDocument = documentsStore[projectId][documentId];
    return parsedDocument?.layers?.primaryTokenLayer?.config?.plaid?.orthographies || [];
  }, [projectId, documentId]);

  // TokenColumn component for displaying individual token annotations
  const TokenColumn = ({ token, tokenIndex }) => {
    const tokenIsIgnored = isTokenIgnored(token, ignoredTokensConfig);

    const handleOrthoUpdate = async (ortho, value) => {
      await operations.updateOrthography(token, ortho.name, value);
    };

    const handleSpanUpdate = async (field, value) => {
      await operations.updateTokenSpan(token, field, value);
    };

    const getTabIndex = (tokenIndex, field) => {
      const allFields = [...orthographyFields.map(o => o.name), ...tokenFields.map(f => f.name)];
      const fieldIndex = allFields.indexOf(field);
      const baseIndex = sentenceIndex * 1000 + (fieldIndex * 100) + tokenIndex + 1;
      return baseIndex;
    };
    
    return (
      <div className="token-column">
        {/* Baseline token text (read-only) */}
        <div className="token-form">
          <VocabLinkPopover
            vocabularies={vocabularies}
            token={token}
            operations={operations}
            readOnly={readOnly}
          >
            {token.content}
          </VocabLinkPopover>
        </div>
        
        {/* Orthography rows */}
        {orthographyFields.map(ortho => (
          <div key={`${token.id}-${ortho.name}`} className="annotation-cell">
            <EditableCell
              value={token.orthographies?.[ortho.name] || ''}
              tokenId={token.id}
              field={ortho.name}
              tabIndex={getTabIndex(tokenIndex, ortho.name)}
              placeholder=""
              isReadOnly={readOnly}
              onUpdate={(value) => handleOrthoUpdate(ortho, value)}
            />
          </div>
        ))}
        
        {/* Annotation field rows - hide for ignored tokens */}
        {!tokenIsIgnored && tokenFields.map(field => (
          <div key={`${token.id}-${field.id}`} className="annotation-cell">
            <EditableCell
              value={token.annotations[field.name]?.value || ''}
              tokenId={token.id}
              field={field.name}
              tabIndex={getTabIndex(tokenIndex, field.name)}
              placeholder=""
              isReadOnly={readOnly}
              onUpdate={(value) => handleSpanUpdate(field, value)}
            />
          </div>
        ))}
        
        {/* Empty cells for ignored tokens to maintain alignment */}
        {tokenIsIgnored && tokenFields.map(field => (
          <div key={`${token.id}-${field.id}-empty`} className="annotation-cell">
            {/* Empty cell */}
          </div>
        ))}
      </div>
    );
  };

  // TokenGrid component for displaying tokens with annotations
  const TokenGrid = () => {
    if (!sentenceSnap.tokens || sentenceSnap.tokens.length === 0) {
      return (
        <Alert icon={<IconInfoCircle size={16} />} color="yellow">
          No tokens found in this sentence.
        </Alert>
      );
    }

    return (
      <div className="token-grid-container">
        {/* Fixed labels column */}
        <div className="labels-column">
          {/* Baseline row - empty space */}
          <div className="row-label"></div>
          
          {/* Orthography rows */}
          {orthographyFields.map(ortho => (
            <div key={ortho.name} className="row-label">
              {ortho.name}
            </div>
          ))}
          
          {/* Annotation field rows */}
          {tokenFields.map(field => (
            <div key={field.id} className="row-label">
              {field.name}
            </div>
          ))}
        </div>
        
        {/* Wrapping tokens container */}
        <div className="tokens-container">
          {sentenceSnap.tokens.map((token, tokenIndex) => (
            <TokenColumn
              key={token.id}
              token={token}
              tokenIndex={tokenIndex}
            />
          ))}
        </div>
      </div>
    );
  };
  
  // SentenceGrid component for sentence-level annotations
  const SentenceGrid = () => {
    if (!sentenceSnap) return null;

    const handleSpanUpdate = async (field, value) => {
      await operations.updateSentenceSpan(sentenceSnap, field, value);
    };
    
    return (
      <Stack spacing="xs" style={{ marginTop: '8px' }}>
        {sentenceFields.length > 0 ? (
          sentenceFields.map(field => (
            <Group key={field.id} align="center">
              <div className="row-label" style={{ minWidth: '100px', height: 'auto', padding: '4px 8px' }}>
                {field.name}
              </div>
              <div style={{ flex: 1 }}>
                <EditableCell
                  value={sentenceSnap.annotations[field.name]?.value || ''}
                  placeholder=""
                  isSentenceLevel={true}
                  isReadOnly={readOnly}
                  onUpdate={(value) => handleSpanUpdate(field, value)}
                />
              </div>
            </Group>
          ))
        ) : (
          <Alert icon={<IconInfoCircle size={16} />} color="yellow">
            No sentence-level annotation fields configured for this project.
          </Alert>
        )}
      </Stack>
    );
  };


  const sentenceNumber = (
   <Text
       size="sm"
       c="dimmed"
       style={{
         position: 'absolute',
         left: '4px',
         top: '12px',
         fontWeight: 500,
         minWidth: '24px',
         textAlign: 'right',
         zIndex: 10
       }}
   >
     {sentenceIndex + 1}
   </Text>
  );

  // Create preview content for lazy loading
  const preview = (
    <>
      {sentenceNumber}
      <div className="token-grid-container">
        <div className="labels-column">
          <div className="row-label"></div>
          {orthographyFields.map(ortho => (
              <div key={ortho.name} className="row-label">
                {ortho.name}
              </div>
          ))}
          {tokenFields.map(field => (
              <div key={field.id} className="row-label">
                {field.name}
              </div>
          ))}
        </div>
        <div className="tokens-container">
          <div className="token-column"><div className="token-form">Lorem</div></div>
          <div className="token-column"><div className="token-form">ipsum</div></div>
          <div className="token-column"><div className="token-form">dolor</div></div>
          <div className="token-column"><div className="token-form">sit</div></div>
          <div className="token-column"><div className="token-form">amet</div></div>
          <div className="token-column"><div className="token-form">consectetu</div></div>
          <div className="token-column"><div className="token-form">adiscing</div></div>
          <div className="token-column"><div className="token-form">elit</div></div>
        </div>
      </div>
      <Stack spacing="xs" style={{ marginTop: '8px' }}>
        {sentenceFields.length > 0 ? (
            sentenceFields.map(field => (
                <Group key={field.id} align="center">
                  <div className="row-label" style={{ minWidth: '100px', height: 'auto', padding: '4px 8px' }}>
                    {field.name}
                  </div>
                  <div style={{ flex: 1 }}>
                    {""}
                  </div>
                </Group>
            ))
        ) : null}
      </Stack>
      <div className="analyze-blur-overlay" />
    </>
  );

  return (
    <Lazy className="analyze-sentence-row" contentPreview={preview}>
      {sentenceNumber}
      <Box>
        <TokenGrid />
        <SentenceGrid />
      </Box>
    </Lazy>
  );
};

export const DocumentAnalyze = ({ projectId, documentId, reload, client, readOnly = false }) => {
  const operations = useAnalyzeOperations(projectId, documentId, reload, client);
  
  // Get snapshots for reactive reading - only subscribe to what we need
  const docProxy = documentsStore[projectId][documentId];
  const docSnap = useSnapshot(docProxy);
  const project = docSnap.project;
  const vocabularies = docSnap.vocabularies || {};
  
  return (
    <div className="document-analyze-container">
      <Stack spacing="lg" mt="md">
        {/* Annotation Grid */}
        <Paper withBorder p="md" className="annotation-grid-paper">
          <Stack spacing="md">
            <Group justify="space-between" align="center">
              <div>
                <Title order={3}>Annotation Grid</Title>
              </div>
              <Group>
                <Tooltip label="Refresh data">
                  <ActionIcon 
                    variant="light" 
                    onClick={() => operations.refreshDocument()} 
                    disabled={readOnly}
                    loading={operations.isRefreshing}
                  >
                    <IconRefresh size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>

            <Divider />
            
            {!docProxy.sentences || docProxy.sentences.length === 0 ? (
              <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                No sentences found. Please tokenize the document first.
              </Alert>
            ) : (
              <Stack spacing="2rem">
                {docProxy.sentences.map((sentenceProxy, sentenceIndex) => (
                  <SentenceRow
                    key={docSnap.sentences[sentenceIndex].id}
                    sentenceProxy={sentenceProxy}
                    sentenceIndex={sentenceIndex}
                    projectId={projectId}
                    documentId={documentId}
                    project={project}
                    vocabularies={vocabularies}
                    operations={operations}
                    readOnly={readOnly}
                  />
                ))}
              </Stack>
            )}
          </Stack>
        </Paper>
      </Stack>
    </div>
  );
};