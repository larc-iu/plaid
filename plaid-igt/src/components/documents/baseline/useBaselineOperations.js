import { useSnapshot } from 'valtio';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import { notifications } from '@mantine/notifications';
import documentsStore from '../../../stores/documentsStore.js';

export const useBaselineOperations = (projectId, documentId, reload, client) => {
  const handleError = useStrictModeErrorHandler(reload);

  const docSnap = useSnapshot(documentsStore[projectId][documentId]);
  const docProxy = documentsStore[projectId][documentId];
  const uiProxy = docProxy.ui.baseline;
  const uiSnap = docSnap.ui.baseline;

  const document = docSnap.document;
  const project = docSnap.project;
  const parsedDocument = docSnap;

  const primaryTextLayer = project?.textLayers?.find(layer => layer.config?.plaid?.primary);

  const handleEdit = () => {
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
    let lockAcquired = false;
    try {
      if (!primaryTextLayer) {
        throw new Error('No primary text layer found');
      }

      const textId = parsedDocument?.document?.text?.id;
      const newText = uiSnap.editedText;
      const newLen = newText.length;

      const layers = parsedDocument.layers;
      const sentenceLayerId = layers?.sentenceTokenLayer?.id;
      if (!sentenceLayerId) {
        throw new Error('No sentence layer found');
      }

      // Acquire lock only after all validation passes — otherwise we'd be calling
      // releaseLock in finally for a lock we never acquired.
      await client.documents.acquireLock(document.id);
      lockAcquired = true;

      // Tokens to wipe before text update:
      // - Sentence tokens (partitioning layer; cascades to word + morpheme via hierarchy)
      // - Alignment tokens (separate root layer; their begin/end are text positions and may
      //   become out-of-bounds if text length changes, which would block the text update)
      const sentenceTokenIds = (layers?.sentenceTokenLayer?.tokens || []).map(t => t.id);
      const alignmentTokenIds = (layers?.alignmentTokenLayer?.tokens || []).map(t => t.id);
      const tokensToWipe = [...sentenceTokenIds, ...alignmentTokenIds];

      if (textId) {
        // Existing text: wipe → update → re-establish partition, all in one batch.
        client.beginBatch();
        if (tokensToWipe.length > 0) {
          client.tokens.bulkDelete(tokensToWipe);
        }
        client.texts.update(textId, newText);
        if (newLen > 0) {
          client.tokens.bulkCreate([{
            tokenLayerId: sentenceLayerId,
            text: textId,
            begin: 0,
            end: newLen,
          }]);
        }
        await client.submitBatch();
      } else {
        // New text: must create text first, then bulk-create sentence in a second batch
        // because batch ops can't reference IDs created earlier in the same batch.
        const newTextObj = await client.texts.create(primaryTextLayer.id, document.id, newText);
        if (newLen > 0) {
          // If bulkCreate fails, we'd wedge the document with a text but no sentence
          // partition. Best-effort compensate by deleting the just-created text.
          try {
            await client.tokens.bulkCreate([{
              tokenLayerId: sentenceLayerId,
              text: newTextObj.id,
              begin: 0,
              end: newLen,
            }]);
          } catch (bulkCreateError) {
            console.error('Sentence partition create failed after text create; rolling back text:', bulkCreateError);
            try {
              await client.texts.delete(newTextObj.id);
            } catch (deleteError) {
              console.error('Failed to roll back text after partition create failure:', deleteError);
            }
            throw bulkCreateError;
          }
        }
      }

      // Optimistically update the store
      if (docProxy.document.text) {
        Object.assign(docProxy.document.text, { body: newText });
      }

      notifications.show({
        title: 'Success',
        message: 'Baseline text saved',
        color: 'green'
      });

      uiProxy.isEditing = false;

      if (reload) {
        reload();
      }
    } catch (error) {
      uiProxy.isEditing = false;
      handleError(error, 'save baseline text', { rollback: true });
    } finally {
      if (lockAcquired) {
        try {
          await client.documents.releaseLock(document.id);
        } catch (lockError) {
          console.error('Failed to release document lock:', lockError);
        }
      }
      uiProxy.saving = false;
    }
  };

  const updateEditedText = (text) => {
    uiProxy.editedText = text;
  };

  return {
    document,
    project,
    parsedDocument,
    primaryTextLayer,
    isEditing: uiSnap.isEditing,
    saving: uiSnap.saving,
    editedText: uiSnap.editedText,

    handleEdit,
    handleCancel,
    handleSave,
    updateEditedText,
  };
};
