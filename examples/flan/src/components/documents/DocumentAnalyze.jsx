import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { 
  Stack, 
  Title, 
  Text, 
  Paper,
  Button,
  Group,
  Alert,
  Divider,
  Select,
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
import IconChevronDown from '@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs';

// EditableCell component for annotation fields
const EditableCell = ({ value, onUpdate, isReadOnly, placeholder, style, isSaving }) => {
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
  
  return (
    <input
      ref={inputRef}
      type="text"
      value={displayValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      readOnly={isDisabled}
      disabled={isUpdating || isSaving}
      style={{
        width: '100%',
        minWidth: '60px',
        padding: '4px 8px',
        border: '1px solid #dee2e6',
        borderRadius: '4px',
        fontSize: '14px',
        backgroundColor: isDisabled ? '#f8f9fa' : hasContent ? '#fff' : '#f8f9fa',
        cursor: isDisabled ? 'default' : 'text',
        opacity: isUpdating || isSaving ? 0.6 : 1,
        ...style
      }}
      title={isDisabled ? (isUpdating ? 'Saving...' : '') : 'Click to edit'}
    />
  );
};

export const DocumentAnalyze = ({ document, parsedDocument, project, client }) => {
  const [selectedSentenceIndex, setSelectedSentenceIndex] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);

  const sentences = parsedDocument?.sentences || [];
  const selectedSentence = sentences[selectedSentenceIndex];
  
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

  // Sentence navigation data
  const sentenceOptions = useMemo(() => {
    return sentences.map((sentence, index) => {
      const sentenceText = getSentenceText(sentence);
      const truncatedText = sentenceText.length > 50 ? sentenceText.substring(0, 50) + '...' : sentenceText;
      return {
        value: index.toString(),
        label: `Sentence ${index + 1}: ${truncatedText}`
      };
    });
  }, [sentences, getSentenceText]);

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
        
        return Math.max(minWidth, tokenWidth, ...annotationWidths);
      });
    }, [tokens, getTokenText]);
    
    return (
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'flex', minWidth: 'fit-content' }}>
          {/* Labels column */}
          <div style={{ 
            minWidth: '100px', 
            borderRight: '1px solid #dee2e6',
            backgroundColor: '#f8f9fa'
          }}>
            {/* Baseline row */}
            <div style={{
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              padding: '8px',
              borderBottom: '1px solid #dee2e6',
              fontWeight: 'bold'
            }}>
              BASELINE
            </div>
            
            {/* Orthography rows */}
            {orthographyFields.map(ortho => (
              <div key={ortho.name} style={{
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                padding: '8px',
                borderBottom: '1px solid #dee2e6',
                fontWeight: 'bold'
              }}>
                {ortho.name.toUpperCase()}
              </div>
            ))}
            
            {/* Annotation field rows */}
            {tokenFields.map(field => (
              <div key={field.id} style={{
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                padding: '8px',
                borderBottom: '1px solid #dee2e6',
                fontWeight: 'bold'
              }}>
                {field.name.toUpperCase()}
              </div>
            ))}
          </div>
          
          {/* Token columns */}
          {tokens.map((token, tokenIndex) => (
            <div key={token.id} style={{
              minWidth: `${columnWidths[tokenIndex]}px`,
              borderRight: tokenIndex < tokens.length - 1 ? '1px solid #dee2e6' : 'none'
            }}>
              {/* Baseline token text (read-only) */}
              <div style={{
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                padding: '8px',
                borderBottom: '1px solid #dee2e6',
                backgroundColor: '#f8f9fa',
                fontFamily: 'monospace'
              }}>
                {getTokenText(token)}
              </div>
              
              {/* Orthography rows */}
              {orthographyFields.map(ortho => (
                <div key={`${token.id}-${ortho.name}`} style={{
                  height: '40px',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px',
                  borderBottom: '1px solid #dee2e6'
                }}>
                  <EditableCell
                    value={token.orthographies?.[ortho.name] || ''}
                    onUpdate={(value) => console.log('TODO: Update orthography', token.id, ortho.name, value)}
                    placeholder={`Enter ${ortho.name}...`}
                    isSaving={saving}
                  />
                </div>
              ))}
              
              {/* Annotation field rows */}
              {tokenFields.map(field => (
                <div key={`${token.id}-${field.id}`} style={{
                  height: '40px',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px',
                  borderBottom: '1px solid #dee2e6'
                }}>
                  <EditableCell
                    value={token.annotations[field.name] || ''}
                    onUpdate={(value) => handleTokenAnnotationUpdate(token.id, field.name, value)}
                    placeholder={`Enter ${field.name}...`}
                    isSaving={saving}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
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
        {/* Sentence text display */}
        <div>
          <Text size="sm" fw={500} c="dimmed">Sentence Text:</Text>
          <Paper bg="gray.0" p="sm" radius="md">
            <Text style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
              {getSentenceText(sentence)}
            </Text>
          </Paper>
        </div>
        
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
    <Stack spacing="lg" mt="md">

      {/* Annotation Grid */}
      <Paper withBorder p="md">
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
            <Stack spacing="md">
              {/* Sentence navigation */}
              <Group>
                <Select
                  label="Select Sentence"
                  value={selectedSentenceIndex.toString()}
                  onChange={(value) => setSelectedSentenceIndex(parseInt(value))}
                  data={sentenceOptions}
                  rightSection={<IconChevronDown size={16} />}
                  style={{ minWidth: '300px' }}
                />
                <Text size="sm" c="dimmed">
                  {sentences.length} sentence{sentences.length !== 1 ? 's' : ''} total
                </Text>
              </Group>
              
              {/* Sentence-level annotations */}
              <SentenceGrid sentence={selectedSentence} />
              
              <Divider />
              
              {/* Token grid */}
              <div>
                <Text size="sm" fw={500} c="dimmed" mb="sm">Token Annotations:</Text>
                {tokenFields.length === 0 && orthographyFields.length === 0 ? (
                  <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                    No token-level annotation fields or orthographies configured for this project.
                  </Alert>
                ) : (
                  <ScrollArea>
                    <TokenGrid sentence={selectedSentence} />
                  </ScrollArea>
                )}
              </div>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
};