import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { 
  Stack, 
  Title, 
  Text, 
  Paper,
  Button,
  Group,
  Alert,
  Divider,
  ActionIcon,
  Tooltip,
  SimpleGrid,
  ScrollArea,
  Box
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconFileText from '@tabler/icons-react/dist/esm/icons/IconFileText.mjs';
import IconLetterA from '@tabler/icons-react/dist/esm/icons/IconLetterA.mjs';
import IconRefresh from '@tabler/icons-react/dist/esm/icons/IconRefresh.mjs';
import './DocumentAnalyze.css';
import { getIgnoredTokensConfig } from '../../utils/tokenizationUtils';

// Shared throttle for tab navigation across all EditableCell instances
let lastGlobalTabPress = 0;

// EditableCell component for annotation fields
const EditableCell = React.memo(({ value, tokenId, field, tabIndex, onUpdate, isReadOnly, placeholder, isSaving, columnWidth }) => {
  const [localValue, setLocalValue] = useState(value || '');
  const [isEditing, setIsEditing] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [pristineValue, setPristineValue] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isEditing) {
      setLocalValue(value || '');
    }
  }, [value, isEditing]);

  const handleChange = (e) => {
    setLocalValue(e.target.value);
  };

  const handleBlur = async (e) => {
    setIsEditing(false);
    const newValue = localValue.trim();
    
    // Compare against pristine value (what it was when focus was gained)
    if (newValue !== (pristineValue || '')) {
      setIsUpdating(true);
      try {
        await onUpdate(newValue || null);
      } catch (error) {
        console.error('Failed to update annotation:', error);
        setLocalValue(value || '');
        
        // Check if it's a non-connection error that requires reload
        const isConnectionError = error.name === 'TypeError' || error.message?.includes('fetch') || error.message?.includes('network');
        if (!isConnectionError) {
          // Non-connection error - reload the document data
          reloadDocument();
          return;
        }
        
        notifications.show({
          title: 'Error',
          message: 'Failed to update annotation',
          color: 'red'
        });
      } finally {
        setIsUpdating(false);
      }
    } else {
      setLocalValue(value || '');
    }
    
    // Clear pristine value
    setPristineValue(null);
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
      inputRef.current?.blur();
    }
  };

  const handleFocus = () => {
    if (!isReadOnly && !isUpdating && !isSaving) {
      setIsEditing(true);
      setPristineValue(value || ''); // Capture pristine value on focus
      setTimeout(() => {
        inputRef.current?.select();
      }, 0);
    }
  };

  const displayValue = localValue || placeholder || '';
  const hasContent = displayValue && displayValue.trim() !== '';
  const isDisabled = isReadOnly || isUpdating || isSaving;
  
  const className = `editable-field ${
    hasContent ? 'editable-field--filled' : 'editable-field--empty'
  } ${
    isDisabled ? 'editable-field--disabled' : ''
  } ${
    isUpdating || isSaving ? 'editable-field--updating' : ''
  }`.trim();
  
  return (
    <input
      ref={inputRef}
      id={tokenId && field ? `${tokenId}-${field}` : undefined}
      type="text"
      value={displayValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      className={className}
      style={columnWidth ? { width: `${columnWidth - 8}px` } : undefined}
      title={isDisabled ? (isUpdating ? 'Saving...' : '') : `Edit ${field || 'annotation'}`}
      tabIndex={tabIndex}
      readOnly={isDisabled}
      disabled={isUpdating || isSaving}
    />
  );
});

// Function to determine if a token should be ignored for annotation
const isTokenIgnored = (token, ignoredTokensConfig) => {
  if (!ignoredTokensConfig) return false;
  
  const tokenText = token.content;
  
  if (ignoredTokensConfig.type === 'unicodePunctuation') {
    // Check if token is all punctuation and not in whitelist
    const isAllPunctuation = [...tokenText].every(char => {
      // Basic Unicode punctuation check (can be extended)
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

export const DocumentAnalyze = ({ document, parsedDocument, project, client, onDocumentReload, setParsedDocumentKey }) => {
  const [saving, setSaving] = useState(false);

  const sentences = parsedDocument?.sentences || [];
  const ignoredTokensConfig = getIgnoredTokensConfig(project);

  // Helper function to reload document data
  const reloadDocument = useCallback(async () => {
    if (onDocumentReload) {
      try {
        await onDocumentReload();
      } catch (error) {
        console.error('Failed to reload document:', error);
      }
    }
  }, [onDocumentReload]);
  
  // Extract available annotation fields from parsed sentences - computed once, stable
  const sentenceFields = useMemo(() => {
    if (!sentences.length) return [];
    const firstSentence = sentences[0];
    const sentenceSpanLayers = parsedDocument?.layers?.spanLayers?.sentence || [];
    
    return Object.keys(firstSentence.annotations || {}).map(name => {
      // Find the actual span layer with this name to get the UUID
      const layer = sentenceSpanLayers.find(layer => layer.name === name);
      return { name, id: layer?.id || name };
    });
  }, [JSON.stringify(parsedDocument.layers.spanLayers.sentence)]);
  
  const tokenFields = useMemo(() => {
    if (!sentences.length || !sentences[0].tokens?.length) return [];
    const firstToken = sentences[0].tokens[0];
    const tokenSpanLayers = parsedDocument?.layers?.spanLayers?.token || [];

    return Object.keys(firstToken.annotations || {}).map(name => {
      // Find the actual span layer with this name to get the UUID
      const layer = tokenSpanLayers.find(layer => layer.name === name);
      return { name, id: layer?.id || name };
    });
  }, [JSON.stringify(parsedDocument.layers.spanLayers.token)]);
  
  // Extract available orthographies from parsed tokens
  const orthographyFields = useMemo(() => {
    return parsedDocument.layers.primaryTokenLayer.config.flan.orthographies.map(x => x.name);
  }, [JSON.stringify(parsedDocument.layers.primaryTokenLayer.config)]);
  
  // API update handlers
  const handleTokenAnnotationUpdate = useCallback(async (sentenceIndex, tokenIndex, token, layerName, value) => {
    if (saving) return;
    
    setSaving(true);
    try {
      const layer = tokenFields.find(field => field.name === layerName);
      if (!layer) {
        throw new Error(`Token annotation layer '${layerName}' not found`);
      }
      
      // Get existing span information from the token
      const existingSpan = token?.spans?.[layerName];
      
      if (value && value.trim()) {
        if (existingSpan) {
          // Update existing span
          await client.spans.update(existingSpan.id, value.trim());
        } else {
          // Create new span annotation
          await client.spans.create(layer.id, [token.id], value.trim());
        }
      } else {
        if (existingSpan) {
          // Delete existing span
          await client.spans.delete(existingSpan.id);
        }
      }
      
      // Update the local state using setParsedDocumentKey
      if (setParsedDocumentKey) {
        const trimmedValue = value ? value.trim() : '';
        setParsedDocumentKey(
          ["sentences", sentenceIndex, "tokens", tokenIndex, "annotations", layerName],
          trimmedValue
        );
      }
    } catch (error) {
      console.error('Failed to update token annotation:', error);
      notifications.show({
        title: 'Error', 
        message: `Failed to update ${layerName}: ${error.message}`,
        color: 'red',
        autoClose: 5000
      });
      throw error;
    } finally {
      setSaving(false);
    }
  }, [tokenFields]);
  
  const handleSentenceAnnotationUpdate = useCallback(async (sentenceIndex, sentence, layerName, value) => {
    if (saving) return; // Prevent concurrent updates
    
    setSaving(true);
    try {
      const layer = sentenceFields.find(field => field.name === layerName);
      if (!layer) {
        throw new Error(`Sentence annotation layer '${layerName}' not found`);
      }
      
      // Get existing span for this field
      const existingSpan = sentence?.spans?.[layerName];
      
      if (value && value.trim()) {
        if (existingSpan) {
          // Update existing span
          await client.spans.update(existingSpan.id, value.trim());
        } else {
          // Create new span annotation anchored on the sentence token
          await client.spans.create(layer.id, [sentence.sentenceToken.id], value.trim());
        }
      } else {
        if (existingSpan) {
          // Delete existing span
          await client.spans.delete(existingSpan.id);
        }
        // If no existing span and no value, nothing to do
      }
      
      // Update the local state using setParsedDocumentKey
      if (setParsedDocumentKey) {
        const trimmedValue = value ? value.trim() : '';
        setParsedDocumentKey(
          ["sentences", sentenceIndex, "annotations", layerName],
          trimmedValue
        );
      }
    } catch (error) {
      console.error('Failed to update sentence annotation:', error);
      notifications.show({
        title: 'Error',
        message: `Failed to update ${layerName}: ${error.message}`,
        color: 'red',
        autoClose: 5000
      });
      throw error;
    } finally {
      setSaving(false);
    }
  }, [sentenceFields]);

  // Handle orthography updates
  const handleOrthographyUpdate = useCallback(async (tokenIndex, token, orthographyName, value) => {
    if (saving) return; // Prevent concurrent updates

    setSaving(true);
    try {
      // Get current metadata and update the orthography key
      const currentMetadata = { ...token.metadata } || {};
      const metadataKey = `orthog:${orthographyName}`;

      if (value && value.trim()) {
        // Set the orthography in metadata using orthog:${name} key pattern
        currentMetadata[metadataKey] = value.trim();
      } else {
        // Remove the orthography from metadata
        delete currentMetadata[metadataKey];
      }

      // Update the entire metadata object
      await client.tokens.setMetadata(token.id, currentMetadata);

      // Update the local state using setParsedDocumentKey
      if (setParsedDocumentKey) {
        const trimmedValue = value ? value.trim() : '';
        setParsedDocumentKey(
            ["sentences", sentenceIndex, "tokens", tokenIndex, "orthographies", orthographyName],
            trimmedValue
        );
      }
    } catch (error) {
      console.error('Failed to update orthography:', error);
      notifications.show({
        title: 'Error',
        message: `Failed to update ${orthographyName}: ${error.message}`,
        color: 'red',
        autoClose: 5000
      });
      throw error;
    } finally {
      setSaving(false);
    }
  }, [orthographyFields]);

  // TokenColumn component for displaying individual token annotations
  const TokenColumn = React.memo(({ token, tokenIndex, sentenceIndex, columnWidth, getTabIndex, tokenFields, orthographyFields, onAnnotationUpdate, onOrthographyUpdate, isSaving, isReadOnly }) => {
    // Check if this token should be ignored
    const tokenIsIgnored = isTokenIgnored(token, ignoredTokensConfig);
    
    return (
      <div className="token-column" style={{ width: `${columnWidth}px` }}>
        {/* Baseline token text (read-only) */}
        <div className="token-form">
          {token.content}
        </div>
        
        {/* Orthography rows - always show for ignored tokens */}
        {orthographyFields.map(ortho => (
          <div key={`${token.id}-${ortho.name}`} className="annotation-cell">
            <EditableCell
              value={token.orthographies?.[ortho.name] || ''}
              tokenId={token.id}
              field={ortho.name}
              tabIndex={getTabIndex ? getTabIndex(tokenIndex, ortho.name) : undefined}
              onUpdate={(value) => onOrthographyUpdate(tokenIndex, token, ortho.name, value)}
              placeholder={``}
              isSaving={isSaving}
              isReadOnly={isReadOnly}
              columnWidth={columnWidth}
            />
          </div>
        ))}
        
        {/* Annotation field rows - hide for ignored tokens */}
        {!tokenIsIgnored && tokenFields.map(field => (
          <div key={`${token.id}-${field.id}`} className="annotation-cell">
            <EditableCell
              value={token.annotations[field.name] || ''}
              tokenId={token.id}
              field={field.name}
              tabIndex={getTabIndex ? getTabIndex(tokenIndex, field.name) : undefined}
              onUpdate={(value) => onAnnotationUpdate(sentenceIndex, tokenIndex, token, field.name, value)}
              placeholder={``}
              isSaving={isSaving}
              isReadOnly={isReadOnly}
              columnWidth={columnWidth}
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
  }, (prevProps, nextProps) => {
    return (
      prevProps.token === nextProps.token &&
      prevProps.tokenIndex === nextProps.tokenIndex &&
      prevProps.columnWidth === nextProps.columnWidth &&
      prevProps.isSaving === nextProps.isSaving &&
      prevProps.isReadOnly === nextProps.isReadOnly &&
      prevProps.onAnnotationUpdate === nextProps.onAnnotationUpdate &&
      prevProps.onOrthographyUpdate === nextProps.onOrthographyUpdate
    );
  });

  // TokenGrid component for displaying tokens with annotations
  const TokenGrid = React.memo(({ sentence, sentenceIndex, tokenFields, orthographyFields, ignoredTokensConfig }) => {
    if (!sentence || !sentence.tokens || sentence.tokens.length === 0) {
      return (
        <Alert icon={<IconInfoCircle size={16} />} color="yellow">
          No tokens found in this sentence.
        </Alert>
      );
    }
    
    const tokens = sentence.tokens;
    
    // Calculate column widths based on content
    const columnWidths = useMemo(() => {
      return tokens.map(token => {
        const charWidth = 8;
        const padding = 16;
        const minWidth = 40;
        
        // Check if token should be ignored
        const tokenIsIgnored = isTokenIgnored(token, ignoredTokensConfig);
        
        if (tokenIsIgnored) {
          // Minimal width for ignored tokens
          const tokenText = token.content;
          const tokenWidth = (tokenText.length * charWidth) + padding;
          return Math.max(24, tokenWidth); // Very minimal width
        }
        
        // Get actual token text content
        const tokenText = token.content;
        const tokenWidth = (tokenText.length * charWidth) + padding;
        
        const annotationWidths = tokenFields.map(field => {
          const value = token.annotations[field.name] || '';
          return (value.length * charWidth) + padding;
        });
        
        const orthographyWidths = orthographyFields.map(ortho => {
          const value = token.orthographies?.[ortho.name] || '';
          return (value.length * charWidth) + padding;
        });
        
        return Math.max(minWidth, tokenWidth, ...annotationWidths, ...orthographyWidths);
      });
    }, [tokens, tokenFields, orthographyFields, ignoredTokensConfig]);

    // Calculate tab indices for navigation - made purely local to this sentence
    const getTabIndex = useCallback((tokenIndex, field) => {
      const allFields = [...orthographyFields.map(o => o.name), ...tokenFields.map(f => f.name)];
      const fieldIndex = allFields.indexOf(field);
      const tokensInSentence = tokens.length;
      
      // Calculate offset from all previous sentences - passed as prop to avoid dependency
      const sentenceOffset = sentenceIndex * 1000; // Simple offset, each sentence gets 1000 tab indices
      
      // Row-wise navigation: field type determines row, token index determines position in row
      return sentenceOffset + (fieldIndex * tokensInSentence) + tokenIndex + 1;
    }, [orthographyFields, tokenFields, sentenceIndex, tokens.length]); // Removed global sentences dependency

    // Detect if we're in read-only mode
    const isReadOnly = false; // TODO: Implement read-only detection
    
    return (
      <div className="token-grid-container">
        {/* Fixed labels column */}
        <div className="labels-column">
          {/* Baseline row - empty space */}
          <div className="row-label">
          </div>
          
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
          {tokens.map((token, tokenIndex) => (
            <TokenColumn
              key={token.id}
              token={token}
              tokenIndex={tokenIndex}
              sentenceIndex={sentenceIndex}
              columnWidth={columnWidths[tokenIndex]}
              getTabIndex={getTabIndex}
              tokenFields={tokenFields}
              orthographyFields={orthographyFields}
              onAnnotationUpdate={handleTokenAnnotationUpdate}
              onOrthographyUpdate={handleOrthographyUpdate}
              isSaving={saving}
              isReadOnly={isReadOnly}
            />
          ))}
        </div>
      </div>
    );
  }, (prevProps, nextProps) => {
    return (
      prevProps.sentence === nextProps.sentence &&
      prevProps.sentenceIndex === nextProps.sentenceIndex &&
      prevProps.tokenFields === nextProps.tokenFields &&
      prevProps.orthographyFields === nextProps.orthographyFields &&
      prevProps.ignoredTokensConfig === nextProps.ignoredTokensConfig
    );
  });
  
  // SentenceGrid component for sentence-level annotations
  const SentenceGrid = React.memo(({ sentence, sentenceIndex, sentenceFields }) => {
    if (!sentence) {
      return null;
    }
    
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
                  value={sentence.annotations[field.name] || ''}
                  onUpdate={(value) => handleSentenceAnnotationUpdate(sentenceIndex, sentence, field.name, value)}
                  placeholder=""
                  isSaving={saving}
                  columnWidth={null}
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
  }, (prevProps, nextProps) => {
    return (
      prevProps.sentence === nextProps.sentence &&
      prevProps.sentenceIndex === nextProps.sentenceIndex &&
      prevProps.sentenceFields === nextProps.sentenceFields
    );
  });
  
  return (
    <div className="document-analyze-container">
      <Stack spacing="lg" mt="md">
        {/* Annotation Grid */}
        <Paper withBorder p="md" className="annotation-grid-paper">
          <Stack spacing="md">
            <Group justify="space-between" align="center">
              <div>
                <Title order={3}>Annotation Grid</Title>
                <Text size="sm" c="dimmed">
                  Edit linguistic annotations for tokens and sentences
                </Text>
              </div>
              <Group>
                <Tooltip label="Refresh data">
                  <ActionIcon variant="light" onClick={() => window.location.reload()}>
                    <IconRefresh size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>

            <Divider />
            
            {sentences.length === 0 ? (
              <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                No sentences found. Please tokenize the document first.
              </Alert>
            ) : (
              <Stack spacing="lg">
                {tokenFields.length === 0 && orthographyFields.length === 0 ? (
                  <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                    No token-level annotation fields or orthographies configured for this project.
                  </Alert>
                ) : (
                  <Stack spacing="2rem">
                    {/* Render all sentences */}
                    {sentences.map((sentence, sentenceIndex) => (
                      <Box
                        key={sentence.id}
                        style={{ 
                          position: 'relative',
                          backgroundColor: sentenceIndex % 2 === 0 ? '#ffffff' : '#f8faff',
                          padding: '12px 16px 12px 50px',
                          borderRadius: '4px'
                        }}
                      >
                        {/* Sentence number */}
                        <Text
                          size="sm"
                          c="dimmed"
                          style={{
                            position: 'absolute',
                            left: '16px',
                            top: '16px',
                            fontWeight: 500,
                            minWidth: '24px',
                            textAlign: 'right'
                          }}
                        >
                          {sentenceIndex + 1}
                        </Text>
                        
                        {/* Sentence content */}
                        <Box>
                          {/* Token grid */}
                          <TokenGrid 
                            sentence={sentence} 
                            sentenceIndex={sentenceIndex}
                            tokenFields={tokenFields}
                            orthographyFields={orthographyFields}
                            ignoredTokensConfig={ignoredTokensConfig}
                          />
                          
                          {/* Sentence-level annotations */}
                          <SentenceGrid 
                            sentence={sentence} 
                            sentenceIndex={sentenceIndex}
                            sentenceFields={sentenceFields}
                          />
                        </Box>
                      </Box>
                    ))}
                  </Stack>
                )}
              </Stack>
            )}
          </Stack>
        </Paper>
      </Stack>
    </div>
  );
};