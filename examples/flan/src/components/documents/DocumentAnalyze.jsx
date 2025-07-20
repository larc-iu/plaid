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
  ScrollArea
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconFileText from '@tabler/icons-react/dist/esm/icons/IconFileText.mjs';
import IconLetterA from '@tabler/icons-react/dist/esm/icons/IconLetterA.mjs';
import IconRefresh from '@tabler/icons-react/dist/esm/icons/IconRefresh.mjs';
import './DocumentAnalyze.css';

// Shared throttle for tab navigation across all EditableCell instances
let lastGlobalTabPress = 0;

// EditableCell component for annotation fields
const EditableCell = React.memo(({ value, tokenId, field, tabIndex, onUpdate, isReadOnly, placeholder, isSaving }) => {
  const [localValue, setLocalValue] = useState(value || '');
  const [isEditing, setIsEditing] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
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
    
    if (newValue !== (value || '')) {
      setIsUpdating(true);
      try {
        await onUpdate(newValue || null);
      } catch (error) {
        console.error('Failed to update annotation:', error);
        setLocalValue(value || '');
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
      title={isDisabled ? (isUpdating ? 'Saving...' : '') : `Edit ${field || 'annotation'}`}
      tabIndex={tabIndex}
      readOnly={isDisabled}
      disabled={isUpdating || isSaving}
    />
  );
});

export const DocumentAnalyze = ({ document, parsedDocument, project, client }) => {
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);

  const sentences = parsedDocument?.sentences || [];
  
  // Extract available annotation fields from parsed sentences
  const sentenceFields = useMemo(() => {
    if (!sentences.length) return [];
    const firstSentence = sentences[0];
    return Object.keys(firstSentence.annotations || {}).map(name => ({ name, id: name }));
  }, [sentences]);
  
  const tokenFields = useMemo(() => {
    if (!sentences.length || !sentences[0].tokens?.length) return [];
    const firstToken = sentences[0].tokens[0];
    return Object.keys(firstToken.annotations || {}).map(name => ({ name, id: name }));
  }, [sentences]);
  
  // Extract available orthographies from parsed tokens
  const orthographyFields = useMemo(() => {
    if (!sentences.length || !sentences[0].tokens?.length) return [];
    const firstToken = sentences[0].tokens[0];
    return Object.keys(firstToken.orthographies || {}).map(name => ({ name, id: name }));
  }, [sentences]);
  
  // Helper function to get token text content
  const getTokenText = useCallback((token) => {
    const textBody = parsedDocument?.document?.text?.body || '';
    return textBody.substring(token.begin, token.end);
  }, [parsedDocument?.document?.text?.body]);
  
  // Helper function to get sentence text content
  const getSentenceText = useCallback((sentence) => {
    if (!sentence?.tokens) return '';
    return sentence.tokens.map(token => getTokenText(token)).join(' ');
  }, [getTokenText]);


  // API update handlers
  const handleTokenAnnotationUpdate = useCallback(async (tokenId, layerName, value) => {
    if (saving) return; // Prevent concurrent updates
    
    setSaving(true);
    try {
      const layer = tokenFields.find(field => field.name === layerName);
      if (!layer) {
        throw new Error(`Token annotation layer '${layerName}' not found`);
      }
      
      if (value && value.trim()) {
        // Create or update span annotation
        await client.spans.create(layer.id, [tokenId], value.trim());
      } else {
        // TODO: Handle deletion of spans when value is empty
        console.log('TODO: Delete span annotation');
      }
      
      notifications.show({
        title: 'Success',
        message: `${layerName} updated`,
        color: 'green',
        autoClose: 2000
      });
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
  }, [client, tokenFields, saving]);
  
  const handleSentenceAnnotationUpdate = useCallback(async (sentenceTokens, layerName, value) => {
    if (saving) return; // Prevent concurrent updates
    
    setSaving(true);
    try {
      const layer = sentenceFields.find(field => field.name === layerName);
      if (!layer) {
        throw new Error(`Sentence annotation layer '${layerName}' not found`);
      }
      
      if (value && value.trim()) {
        const tokenIds = sentenceTokens.map(token => token.id);
        await client.spans.create(layer.id, tokenIds, value.trim());
      } else {
        console.log('TODO: Delete span annotation');
      }
      
      notifications.show({
        title: 'Success',
        message: `Sentence ${layerName} updated`,
        color: 'green',
        autoClose: 2000
      });
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
  }, [client, sentenceFields, saving]);

  const handleAutoTokenize = async () => {
    setProcessing(true);
    try {
      console.log('Auto-tokenizing document...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('Failed to auto-tokenize:', error);
    } finally {
      setProcessing(false);
    }
  };

  const handleAutoSegment = async () => {
    setProcessing(true);
    try {
      console.log('Auto-segmenting sentences...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('Failed to auto-segment:', error);
    } finally {
      setProcessing(false);
    }
  };

  // TokenColumn component for displaying individual token annotations
  const TokenColumn = React.memo(({ token, tokenIndex, columnWidth, getTabIndex, tokenFields, orthographyFields, onAnnotationUpdate, onOrthographyUpdate, isSaving, isReadOnly }) => {
    return (
      <div className="token-column" style={{ width: `${columnWidth}px` }}>
        {/* Baseline token text (read-only) */}
        <div className="token-form">
          {getTokenText(token)}
        </div>
        
        {/* Orthography rows */}
        {orthographyFields.map(ortho => (
          <div key={`${token.id}-${ortho.name}`} className="annotation-cell">
            <EditableCell
              value={token.orthographies?.[ortho.name] || ''}
              tokenId={token.id}
              field={ortho.name}
              tabIndex={getTabIndex ? getTabIndex(tokenIndex, ortho.name) : undefined}
              onUpdate={(value) => onOrthographyUpdate(token.id, ortho.name, value)}
              placeholder={`Enter ${ortho.name}...`}
              isSaving={isSaving}
              isReadOnly={isReadOnly}
            />
          </div>
        ))}
        
        {/* Annotation field rows */}
        {tokenFields.map(field => (
          <div key={`${token.id}-${field.id}`} className="annotation-cell">
            <EditableCell
              value={token.annotations[field.name] || ''}
              tokenId={token.id}
              field={field.name}
              tabIndex={getTabIndex ? getTabIndex(tokenIndex, field.name) : undefined}
              onUpdate={(value) => onAnnotationUpdate(token.id, field.name, value)}
              placeholder={`Enter ${field.name}...`}
              isSaving={isSaving}
              isReadOnly={isReadOnly}
            />
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
  const TokenGrid = ({ sentence }) => {
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
        const minWidth = 80;
        
        // Get actual token text content
        const tokenText = getTokenText(token);
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
    }, [tokens, getTokenText, tokenFields, orthographyFields]);

    // Calculate tab indices for navigation
    const getTabIndex = useCallback((tokenIndex, field) => {
      const allFields = [...orthographyFields.map(o => o.name), ...tokenFields.map(f => f.name)];
      const fieldIndex = allFields.indexOf(field);
      const tokensInSentence = tokens.length;
      
      // Row-wise navigation: field type determines row, token index determines position in row
      return (fieldIndex * tokensInSentence) + tokenIndex + 1;
    }, [orthographyFields, tokenFields, tokens.length]);

    // Handle orthography updates
    const handleOrthographyUpdate = useCallback(async (tokenId, orthographyName, value) => {
      console.log('TODO: Update orthography', tokenId, orthographyName, value);
      // TODO: Implement orthography update logic
    }, []);

    // Detect if we're in read-only mode
    const isReadOnly = false; // TODO: Implement read-only detection
    
    return (
      <div className="sentence-grid">
        {/* Labels column */}
        <div className="labels-column">
          {/* Baseline row */}
          <div className="row-label">
            BASELINE
          </div>
          
          {/* Orthography rows */}
          {orthographyFields.map(ortho => (
            <div key={ortho.name} className="row-label">
              {ortho.name.toUpperCase()}
            </div>
          ))}
          
          {/* Annotation field rows */}
          {tokenFields.map(field => (
            <div key={field.id} className="row-label">
              {field.name.toUpperCase()}
            </div>
          ))}
        </div>
        
        {/* Token columns */}
        {tokens.map((token, tokenIndex) => (
          <TokenColumn
            key={token.id}
            token={token}
            tokenIndex={tokenIndex}
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
    );
  };
  
  // SentenceGrid component for sentence-level annotations
  const SentenceGrid = ({ sentence }) => {
    if (!sentence) {
      return null;
    }
    
    return (
      <Stack spacing="sm">
        {/* Sentence annotation fields */}
        {sentenceFields.length > 0 && (
          <div>
            <Text size="sm" fw={500} c="dimmed" mb="xs">Sentence Annotations:</Text>
            <Stack spacing="xs">
              {sentenceFields.map(field => (
                <Group key={field.id} align="center">
                  <Text size="sm" fw={500} style={{ minWidth: '100px' }}>
                    {field.name}:
                  </Text>
                  <div style={{ flex: 1 }}>
                    <EditableCell
                      value={sentence.annotations[field.name] || ''}
                      onUpdate={(value) => handleSentenceAnnotationUpdate(sentence.tokens, field.name, value)}
                      placeholder={`Enter ${field.name}...`}
                      style={{ width: '100%' }}
                      isSaving={saving}
                    />
                  </div>
                </Group>
              ))}
            </Stack>
          </div>
        )}
        
        {sentenceFields.length === 0 && (
          <Alert icon={<IconInfoCircle size={16} />} color="yellow">
            No sentence-level annotation fields configured for this project.
          </Alert>
        )}
      </Stack>
    );
  };
  
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
                <Text size="sm" c="dimmed">
                  {sentences.length} sentence{sentences.length !== 1 ? 's' : ''} total
                </Text>
                
                {tokenFields.length === 0 && orthographyFields.length === 0 ? (
                  <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                    No token-level annotation fields or orthographies configured for this project.
                  </Alert>
                ) : (
                  <Stack spacing="xl">
                    {/* Render all sentences */}
                    {sentences.map((sentence, sentenceIndex) => (
                      <div key={sentenceIndex}>
                        {/* Sentence-level annotations */}
                        <SentenceGrid sentence={sentence} />
                        
                        <Divider my="sm" />
                        
                        {/* Token grid */}
                        <ScrollArea>
                          <TokenGrid sentence={sentence} />
                        </ScrollArea>
                      </div>
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