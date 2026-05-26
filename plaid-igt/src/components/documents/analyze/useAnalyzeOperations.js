import { useSnapshot } from 'valtio';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import documentsStore from '../../../stores/documentsStore.js';

export const useAnalyzeOperations = (projectId, documentId, reload, client) => {
  const handleError = useStrictModeErrorHandler(reload);
  
  // Get the document proxy (no snapshot subscription here to avoid full re-renders)
  const docProxy = documentsStore[projectId][documentId];
  const uiProxy = docProxy.ui.analyze;
  
  // Only subscribe to the specific UI state we need
  const uiSnap = useSnapshot(uiProxy);
  
  // Handle orthography updates
  const updateOrthography = async (token, orthoName, value) => {
    try {
      const metadata = { ...token.metadata };
      const key = `orthog:${orthoName}`;
      metadata[key] = value;
      
      await client.tokens.setMetadata(token.id, metadata);
      
      // Don't update store optimistically - let local state handle it
      
    } catch (error) {
      handleError(error, 'update orthography');
    }
  };

  // Handle span annotation updates (token-level)
  const updateTokenSpan = async (token, field, value) => {
    try {
      const extantSpan = token.annotations[field.name];
      
      if (!extantSpan) {
        // Create new span
        await client.spans.create(field.id, [token.id], value);
        
        // Don't update store optimistically - let local state handle it
      } else {
        // Update existing span
        await client.spans.update(extantSpan.id, value);
        
        // Don't update store optimistically - let local state handle it
      }
      
    } catch (error) {
      handleError(error, 'update token annotation');
    }
  };

  // Handle span annotation updates (sentence-level)
  const updateSentenceSpan = async (sentence, field, value) => {
    try {
      const extantSpan = sentence.annotations[field.name];
      
      if (!extantSpan) {
        // Create new span
        await client.spans.create(field.id, [sentence.id], value);
        
        // Don't update store optimistically - let local state handle it
      } else {
        // Update existing span
        await client.spans.update(extantSpan.id, value);
        
        // Don't update store optimistically - let local state handle it
      }
      
    } catch (error) {
      handleError(error, 'update sentence annotation');
    }
  };

  // Handle vocabulary operations
  const handleVocabOperation = async (operation, ...args) => {
    try {
      // The VocabLinkPopover will handle the actual API calls
      // This is just for coordinating UI state
      return await operation(...args);
    } catch (error) {
      handleError(error, 'vocabulary operation');
      throw error; // Re-throw so VocabLinkPopover can handle it
    }
  };

  // Handle morpheme span annotation updates
  const updateMorphemeSpan = async (morpheme, field, value) => {
    try {
      const extantSpan = morpheme.annotations[field.name];
      
      if (!extantSpan) {
        // Create new span
        await client.spans.create(field.id, [morpheme.id], value);
        
        // Don't update store optimistically - let local state handle it
      } else {
        // Update existing span
        await client.spans.update(extantSpan.id, value);
        
        // Don't update store optimistically - let local state handle it
      }
      
    } catch (error) {
      handleError(error, 'update morpheme annotation');
    }
  };

  // Handle morpheme form updates (metadata.form)
  const updateMorphemeForm = async (morpheme, form) => {
    try {
      const metadata = { ...morpheme.metadata };
      metadata.form = form;
      
      await client.tokens.setMetadata(morpheme.id, metadata);
      
      // Don't update store optimistically - let local state handle it
      
    } catch (error) {
      handleError(error, 'update morpheme form');
    }
  };

  // Refresh document data
  const refreshDocument = async () => {
    try {
      uiProxy.refreshing = true;
      if (reload) {
        await reload();
      }
    } catch (error) {
      handleError(error, 'refresh document');
    } finally {
      uiProxy.refreshing = false;
    }
  };

  return {
    updateOrthography,
    updateTokenSpan,
    updateSentenceSpan,
    updateMorphemeSpan,
    updateMorphemeForm,
    handleVocabOperation,
    refreshDocument,
    isRefreshing: uiSnap.refreshing,
    client // Add client for batch operations
  };
};