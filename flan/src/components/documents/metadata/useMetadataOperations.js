import { useNavigate } from 'react-router-dom';
import { useSnapshot } from 'valtio';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import { notifications } from '@mantine/notifications';
import documentsStore from '../../../stores/documentsStore.js';

export const useMetadataOperations = (projectId, documentId, reload, client) => {
  const navigate = useNavigate();
  const handleError = useStrictModeErrorHandler(reload);
  
  // Get the document snapshot and proxy
  const docSnap = useSnapshot(documentsStore[projectId][documentId]);
  const docProxy = documentsStore[projectId][documentId];
  const uiProxy = docProxy.ui.metadata;
  const uiSnap = docSnap.ui.metadata;
  
  const document = docSnap.document;
  const project = docSnap.project;
  
  // Get metadata fields configuration from project
  const metadataFields = project.config.plaid.documentMetadata || [];

  const handleEdit = () => {
    uiProxy.editedName = document.name || '';
    
    // Initialize edited metadata with current values for configured fields
    const initialMetadata = {};
    metadataFields.forEach(field => {
      initialMetadata[field.name] = document.metadata[field.name] || '';
    });
    uiProxy.editedMetadata = initialMetadata;
    
    uiProxy.isEditing = true;
  };

  const handleCancel = () => {
    uiProxy.editedName = '';
    uiProxy.editedMetadata = {};
    uiProxy.isEditing = false;
  };

  const handleSave = async () => {
    uiProxy.saving = true;
    try {
      // Update document name if changed
      if (uiSnap.editedName !== document.name) {
        await client.documents.update(document.id, uiSnap.editedName);
      }
      
      // Prepare complete metadata object with all existing metadata plus edits
      const completeMetadata = {
        ...document.metadata, // Keep existing metadata (including deactivated fields)
        ...uiSnap.editedMetadata // Override with edited values
      };
      
      // Update document metadata
      await client.documents.setMetadata(document.id, completeMetadata);
      
      // Optimistically update the store
      Object.assign(docProxy.document, {
        name: uiSnap.editedName,
        metadata: completeMetadata
      });
      
      uiProxy.isEditing = false;
      
    } catch (error) {
      uiProxy.isEditing = false;
      handleError(error, 'save document metadata');
    } finally {
      uiProxy.saving = false;
    }
  };

  const handleDeleteClick = () => {
    uiProxy.deleteModalOpen = true;
  };

  const handleCloseDeleteModal = () => {
    uiProxy.deleteModalOpen = false;
  };

  const handleDelete = async () => {
    uiProxy.deleting = true;
    try {
      await client.documents.delete(document.id);
      
      notifications.show({
        title: 'Document deleted',
        message: `"${document.name}" has been successfully deleted.`,
        color: 'green'
      });
      
      // Navigate back to the project page
      navigate(`/projects/${projectId}`);
    } catch (error) {
      handleError(error, 'delete document');
    } finally {
      uiProxy.deleting = false;
      uiProxy.deleteModalOpen = false;
    }
  };

  const updateEditedName = (name) => {
    uiProxy.editedName = name;
  };

  const updateEditedMetadata = (fieldName, value) => {
    uiProxy.editedMetadata = {
      ...uiSnap.editedMetadata,
      [fieldName]: value
    };
  };

  return {
    // State
    document,
    project,
    metadataFields,
    isEditing: uiSnap.isEditing,
    saving: uiSnap.saving,
    deleting: uiSnap.deleting,
    deleteModalOpen: uiSnap.deleteModalOpen,
    editedName: uiSnap.editedName,
    editedMetadata: uiSnap.editedMetadata,
    
    // Actions
    handleEdit,
    handleCancel,
    handleSave,
    handleDeleteClick,
    handleCloseDeleteModal,
    handleDelete,
    updateEditedName,
    updateEditedMetadata
  };
};