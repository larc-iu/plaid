import { useSnapshot } from 'valtio';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import { notifications } from '@mantine/notifications';
import documentsStore from '../../../stores/documentsStore.js';

/**
 * Ensures sentence tokens properly partition the entire text body
 * @param {Object} client - API client
 * @param {Object} document - Document data
 * @param {Object} project - Project data
 * @param {string} textContent - The text content to partition
 */
const ensureSentencePartitioning = async (client, document, project, textContent) => {
  // Get the sentence token layer
  const primaryTextLayer = project?.textLayers?.find(layer => layer.config?.plaid?.primary);
  const sentenceTokenLayer = primaryTextLayer?.tokenLayers?.find(layer => layer.config?.plaid?.sentence);
  
  if (!sentenceTokenLayer) {
    throw new Error('No sentence token layer found');
  }

  // Get existing sentence tokens from the document data
  const docSentenceTokenLayer = document?.textLayers
    ?.find(layer => layer.config?.plaid?.primary)
    ?.tokenLayers?.find(layer => layer.config?.plaid?.sentence);
  
  const existingSentenceTokens = docSentenceTokenLayer?.tokens || [];
  const sortedSentences = [...existingSentenceTokens].sort((a, b) => a.begin - b.begin);
  
  if (sortedSentences.length === 0) {
    // No sentence tokens exist, create one covering the entire text
    const textId = document?.textLayers?.find(layer => layer.config?.plaid?.primary)?.text?.id;
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
 * @param {Function} handleError - Error handler function
 */
const checkAndFixTokenization = async (client, document, project, parsedDocument, handleError) => {
  const textLayer = document?.textLayers?.find(layer => layer.config?.plaid?.primary);
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
    if (handleError) {
      handleError(error, 'fix tokenization');
    } else {
      console.error('Failed to fix tokenization:', error);
    }
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

export const useBaselineOperations = (projectId, documentId, reload, client) => {
  const handleError = useStrictModeErrorHandler(reload);
  
  // Get the document snapshot and proxy
  const docSnap = useSnapshot(documentsStore[projectId][documentId]);
  const docProxy = documentsStore[projectId][documentId];
  const uiProxy = docProxy.ui.baseline;
  const uiSnap = docSnap.ui.baseline;
  
  const document = docSnap.document;
  const project = docSnap.project;
  const parsedDocument = docSnap;
  
  // Get the primary text layer from project
  const primaryTextLayer = project?.textLayers?.find(layer => layer.config?.plaid?.primary);

  const handleEdit = () => {
    // Load current text content from parsed document
    const currentText = parsedDocument?.document?.text?.body || '';
    uiProxy.editedText = currentText;
    uiProxy.isEditing = true;
  };

  const handleCancel = () => {
    uiProxy.editedText = '';
    uiProxy.isEditing = false;
  };

  const handleSave = async () => {
    uiProxy.saving = true;
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
        await client.texts.update(textId, uiSnap.editedText);
        
        // Get existing metadata and add dirty flag
        const existingMetadata = document?.text?.metadata || {};
        const updatedMetadata = { ...existingMetadata, _tokenizationDirty: true };
        await client.texts.setMetadata(textId, updatedMetadata);
      } else {
        // Create new text with dirty flag
        await client.texts.create(primaryTextLayer.id, document.id, uiSnap.editedText, { _tokenizationDirty: true });
      }
      
      await client.submitBatch();
      
      // Phase 2: Fetch updated document and fix sentence partitioning
      const updatedDocumentData = await client.documents.get(document.id, true);
      
      client.beginBatch();
      
      // Fix sentence partitioning with the new text
      await ensureSentencePartitioning(client, updatedDocumentData, project, uiSnap.editedText);
      
      // Remove dirty flag
      const finalTextId = updatedDocumentData?.textLayers?.find(layer => layer.config?.plaid?.primary)?.text?.id;
      if (finalTextId) {
        const finalMetadata = updatedDocumentData?.textLayers?.find(layer => layer.config?.plaid?.primary)?.text?.metadata || {};
        const cleanedMetadata = { ...finalMetadata };
        delete cleanedMetadata._tokenizationDirty;
        await client.texts.setMetadata(finalTextId, cleanedMetadata);
      }
      
      await client.submitBatch();
      
      // Optimistically update the store
      Object.assign(docProxy.document.text, {
        body: uiSnap.editedText
      });
      
      notifications.show({
        title: 'Success',
        message: 'Baseline text saved',
        color: 'green'
      });
      
      uiProxy.isEditing = false;
      
    } catch (error) {
      uiProxy.isEditing = false;
      handleError(error, 'save baseline text');
    } finally {
      // Release document lock
      try {
        await client.documents.releaseLock(document.id);
      } catch (lockError) {
        console.error('Failed to release document lock:', lockError);
      }
      uiProxy.saving = false;
    }
  };

  const updateEditedText = (text) => {
    uiProxy.editedText = text;
  };

  // Check for dirty tokenization on component initialization
  const checkDirtyTokenization = async () => {
    if (document && project && parsedDocument && client) {
      const wasFixed = await checkAndFixTokenization(client, document, project, parsedDocument, handleError);
      if (wasFixed && reload) {
        reload(); // Trigger parent component refresh
      }
    }
  };

  return {
    // State
    document,
    project,
    parsedDocument,
    primaryTextLayer,
    isEditing: uiSnap.isEditing,
    saving: uiSnap.saving,
    editedText: uiSnap.editedText,
    
    // Actions
    handleEdit,
    handleCancel,
    handleSave,
    updateEditedText,
    checkDirtyTokenization
  };
};