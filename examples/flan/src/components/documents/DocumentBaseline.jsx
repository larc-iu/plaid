import { useState, useEffect } from 'react';
import { 
  Stack, 
  Title, 
  Text, 
  Paper,
  Textarea,
  Button,
  Group,
  Alert,
  Divider,
  Badge
} from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconEdit from '@tabler/icons-react/dist/esm/icons/IconEdit.mjs';
import IconDeviceFloppy from '@tabler/icons-react/dist/esm/icons/IconDeviceFloppy.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import { notifications } from '@mantine/notifications';
import { useStrictClient } from '../../contexts/StrictModeContext';

/**
 * Ensures sentence tokens properly partition the entire text body
 * @param {Object} client - API client
 * @param {Object} document - Document data
 * @param {Object} project - Project data
 * @param {string} textContent - The text content to partition
 */
const ensureSentencePartitioning = async (client, document, project, textContent) => {
  // Get the sentence token layer
  const primaryTextLayer = project?.textLayers?.find(layer => layer.config?.flan?.primary);
  const sentenceTokenLayer = primaryTextLayer?.tokenLayers?.find(layer => layer.config?.flan?.sentence);
  
  if (!sentenceTokenLayer) {
    throw new Error('No sentence token layer found');
  }

  // Get existing sentence tokens from the document data
  const docSentenceTokenLayer = document?.textLayers
    ?.find(layer => layer.config?.flan?.primary)
    ?.tokenLayers?.find(layer => layer.config?.flan?.sentence);
  
  const existingSentenceTokens = docSentenceTokenLayer?.tokens || [];
  const sortedSentences = [...existingSentenceTokens].sort((a, b) => a.begin - b.begin);
  
  if (sortedSentences.length === 0) {
    // No sentence tokens exist, create one covering the entire text
    const textId = document?.textLayers?.find(layer => layer.config?.flan?.primary)?.text?.id;
    if (textId && textContent.length > 0) {
      await client.tokens.create(
        sentenceTokenLayer.id,
        textId,
        0,
        textContent.length
      );
    }
    return;
  }

  // Expand each sentence to cover any gaps to its right
  for (let i = 0; i < sortedSentences.length; i++) {
    const currentSentence = sortedSentences[i];
    const nextSentence = sortedSentences[i + 1];
    
    if (nextSentence && currentSentence.end < nextSentence.begin) {
      // There's a gap between this sentence and the next, expand current sentence
      await client.tokens.update(
        currentSentence.id,
        i === 0 ? 0 : currentSentence.begin,
        nextSentence.begin
      );
    } else if (!nextSentence && currentSentence.end < textContent.length) {
      // This is the last sentence and it doesn't cover the end of the text
      await client.tokens.update(
        currentSentence.id,
        i === 0 ? 0 : currentSentence.begin,
        textContent.length
      );
    }
  }
};

/**
 * Checks if text has dirty tokenization flag and fixes it if needed
 * @param {Object} client - API client
 * @param {Object} document - Document data
 * @param {Object} project - Project data
 * @param {Object} parsedDocument - Parsed document data
 */
const checkAndFixTokenization = async (client, document, project, parsedDocument) => {
  const textLayer = document?.textLayers?.find(layer => layer.config?.flan?.primary);
  const text = textLayer?.text;
  
  if (!text || !text.metadata?._tokenizationDirty) {
    return false; // No fix needed
  }

  try {
    // Acquire document lock (idempotent)
    await client.documents.acquireLock(document.id);
    
    client.beginBatch();
    
    // Fix sentence partitioning
    await ensureSentencePartitioning(client, document, project, text.body);
    
    // Remove dirty flag
    const updatedMetadata = { ...text.metadata };
    delete updatedMetadata._tokenizationDirty;
    await client.texts.setMetadata(text.id, updatedMetadata);
    
    await client.submitBatch();
    return true; // Fix was applied
  } catch (error) {
    console.error('Failed to fix tokenization:', error);
    return false;
  } finally {
    // Release document lock
    try {
      await client.documents.releaseLock(document.id);
    } catch (lockError) {
      console.error('Failed to release document lock:', lockError);
    }
  }
};

export const DocumentBaseline = ({ document, parsedDocument, project, onTextUpdated }) => {
  const client = useStrictClient();
  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState('');
  const [saving, setSaving] = useState(false);

  // Get the primary text layer from project
  const primaryTextLayer = project?.textLayers?.find(layer => layer.config?.flan?.primary);

  // Check for dirty tokenization flag on component mount/update
  useEffect(() => {
    const checkDirtyTokenization = async () => {
      if (document && project && parsedDocument && client) {
        const wasFixed = await checkAndFixTokenization(client, document, project, parsedDocument);
        if (wasFixed && onTextUpdated) {
          onTextUpdated(); // Trigger parent component refresh
        }
      }
    };

    checkDirtyTokenization();
  }, [document, project, parsedDocument, client, onTextUpdated]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (!primaryTextLayer) {
        throw new Error('No primary text layer found');
      }

      // Acquire document lock (idempotent)
      await client.documents.acquireLock(document.id);

      // Phase 1: Save text + mark as dirty
      const textId = parsedDocument?.document?.text?.id;

      client.beginBatch();

      if (textId) {
        // Update existing text
        await client.texts.update(textId, editedText);
        
        // Get existing metadata and add dirty flag
        const existingMetadata = document?.textLayers?.find(layer => layer.config?.flan?.primary)?.text?.metadata || {};
        const updatedMetadata = { ...existingMetadata, _tokenizationDirty: true };
        await client.texts.setMetadata(textId, updatedMetadata);
      } else {
        // Create new text with dirty flag
        await client.texts.create(primaryTextLayer.id, document.id, editedText, { _tokenizationDirty: true });
      }
      
      await client.submitBatch();
      
      // Phase 2: Fetch updated document and fix sentence partitioning
      const updatedDocumentData = await client.documents.get(document.id, true);
      
      client.beginBatch();
      
      // Fix sentence partitioning with the new text
      await ensureSentencePartitioning(client, updatedDocumentData, project, editedText);
      
      // Remove dirty flag
      const finalTextId = updatedDocumentData?.textLayers?.find(layer => layer.config?.flan?.primary)?.text?.id;
      if (finalTextId) {
        const finalMetadata = updatedDocumentData?.textLayers?.find(layer => layer.config?.flan?.primary)?.text?.metadata || {};
        const cleanedMetadata = { ...finalMetadata };
        delete cleanedMetadata._tokenizationDirty;
        await client.texts.setMetadata(finalTextId, cleanedMetadata);
      }
      
      await client.submitBatch();
      
      notifications.show({
        title: 'Success',
        message: 'Baseline text saved',
        color: 'green'
      });
      
      // Update parent component's parsed document state
      if (onTextUpdated) {
        onTextUpdated();
      }
      
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to save baseline text:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to save baseline text: ' + error.message,
        color: 'red'
      });
    } finally {
      // Release document lock
      try {
        await client.documents.releaseLock(document.id);
      } catch (lockError) {
        console.error('Failed to release document lock:', lockError);
      }
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedText('');
    setIsEditing(false);
  };

  const handleEdit = () => {
    // Load current text content from parsed document
    const currentText = parsedDocument?.document?.text?.body || '';
    setEditedText(currentText);
    setIsEditing(true);
  };

  return (
    <Stack spacing="lg" mt="md">
      <Paper withBorder p="md">
        <Stack spacing="md">
          <Group justify="space-between" align="center">
            <div>
              <Title order={3}>Baseline Text</Title>
              <Text size="sm" c="dimmed">
                Edit the primary text content for this document
              </Text>
            </div>
            {!isEditing && (
              <Button
                leftSection={<IconEdit size={16} />}
                variant="light"
                size="sm"
                onClick={handleEdit}
              >
                Edit Text
              </Button>
            )}
          </Group>

          <Divider />

          {isEditing ? (
            <Stack spacing="md">
              <Textarea
                label="Document Text"
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                placeholder="Enter the document text..."
                minRows={10}
                maxRows={20}
                autosize
                required
              />

              <Alert icon={<IconInfoCircle size={16} />} color="yellow">
                <Text size="sm">
                  <strong>Note:</strong> Editing the baseline text will affect all existing 
                  tokens and annotations. Make sure to review your changes carefully.
                </Text>
              </Alert>

              <Group justify="flex-end">
                <Button
                  variant="outline"
                  leftSection={<IconX size={16} />}
                  onClick={handleCancel}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  leftSection={<IconDeviceFloppy size={16} />}
                  onClick={handleSave}
                  loading={saving}
                >
                  Save Changes
                </Button>
              </Group>
            </Stack>
          ) : (
            <Stack spacing="md">
              <div>
                <Paper bg="gray.0" p="md" radius="md">
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {parsedDocument?.document?.text?.body || ''}
                  </Text>
                </Paper>
              </div>

              {!primaryTextLayer && (
                <Alert icon={<IconInfoCircle size={16} />} color="red">
                  No primary text layer found for this project. Text editing is not available.
                </Alert>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
};