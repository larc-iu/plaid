import { useSnapshot } from 'valtio';
import { useStrictClient } from '../contexts/StrictModeContext.jsx';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import { notifications } from '@mantine/notifications';
import documentsStore from '../../../stores/documentsStore.js';

export const useAnalyzeOperations = (projectId, documentId, reload, client) => {
  console.log('[DEBUG] useAnalyzeOperations re-executed');
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

  // Create new morpheme token
  const createMorpheme = async (wordToken, precedence, form = '') => {
    try {
      // Create morpheme token with same extent as word token and precedence
      const morphemeToken = await client.tokens.create(
        wordToken.text, 
        wordToken.begin, 
        wordToken.end,
        precedence
      );
      
      // Set form if provided
      if (form) {
        await client.tokens.setMetadata(morphemeToken.id, { form });
      }
      
      // Refresh document to show the new morpheme
      if (reload) {
        await reload();
      }
      
      return morphemeToken;
      
    } catch (error) {
      handleError(error, 'create morpheme');
      throw error; // Re-throw for caller handling
    }
  };

  // Delete morpheme token
  const deleteMorpheme = async (morphemeId) => {
    try {
      await client.tokens.delete(morphemeId);
      
      // Refresh document to reflect the deletion
      if (reload) {
        await reload();
      }
      
    } catch (error) {
      handleError(error, 'delete morpheme');
      throw error; // Re-throw for caller handling
    }
  };

  // Update morpheme precedence for reordering
  const updateMorphemePrecedence = async (morphemeId, newPrecedence) => {
    try {
      await client.tokens.update(morphemeId, undefined, undefined, newPrecedence);
      
    } catch (error) {
      handleError(error, 'update morpheme precedence');
      throw error; // Re-throw for caller handling
    }
  };

  // Split morpheme at position
  const splitMorpheme = async (morpheme, splitPosition, leftForm, rightForm) => {
    try {
      // Update the original morpheme's form to be the left part
      await updateMorphemeForm(morpheme, leftForm);
      
      // Create new morpheme for the right part
      const rightMorpheme = await createMorpheme(
        { text: morpheme.text, begin: morpheme.begin, end: morpheme.end },
        morpheme.precedence + 1,
        rightForm
      );
      
      // Update precedences of all morphemes after this one
      // This would need to be batched in a real implementation
      // For now, we'll let the next document reload handle precedence adjustments
      
      // Refresh document to show the new morpheme
      if (reload) {
        await reload();
      }
      
      return rightMorpheme;
      
    } catch (error) {
      handleError(error, 'split morpheme');
      throw error; // Re-throw for caller handling
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
    createMorpheme,
    deleteMorpheme,
    updateMorphemePrecedence,
    splitMorpheme,
    handleVocabOperation,
    refreshDocument,
    isRefreshing: uiSnap.refreshing,
    client // Add client for batch operations
  };
};