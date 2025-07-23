import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { 
  Stack, 
  Title, 
  Text, 
  Paper,
  TextInput,
  Button,
  Group,
  Alert,
  Divider,
  Modal
} from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconEdit from '@tabler/icons-react/dist/esm/icons/IconEdit.mjs';
import IconDeviceFloppy from '@tabler/icons-react/dist/esm/icons/IconDeviceFloppy.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconAlertTriangle from '@tabler/icons-react/dist/esm/icons/IconAlertTriangle.mjs';
import { useStrictClient } from '../../contexts/StrictModeContext';
import { notifications } from '@mantine/notifications';
import { useDisclosure } from '@mantine/hooks';
import { useStrictModeErrorHandler } from './hooks/useStrictModeErrorHandler';

export const DocumentMetadata = ({ document, parsedDocument, project, onDocumentUpdated, onDocumentReload }) => {
  const client = useStrictClient();
  const handleStrictModeError = useStrictModeErrorHandler(onDocumentReload);
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(document?.name || '');
  const [editedMetadata, setEditedMetadata] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteModalOpened, { open: openDeleteModal, close: closeDeleteModal }] = useDisclosure(false);

  // Get metadata fields configuration from project
  const metadataFields = project?.config?.flan?.documentMetadata || [];

  const handleSave = async () => {
    setSaving(true);
    try {
      // Update document name if changed
      if (editedName !== document?.name) {
        await client.documents.update(document.id, editedName);
      }
      
      // Prepare complete metadata object with all existing metadata plus edits
      const completeMetadata = {
        ...document?.metadata, // Keep existing metadata (including deactivated fields)
        ...editedMetadata // Override with edited values
      };
      
      // Update document metadata
      await client.documents.setMetadata(document.id, completeMetadata);
      
      // Update parent component's document state
      if (onDocumentUpdated) {
        onDocumentUpdated(prevDocument => ({
          ...prevDocument,
          name: editedName,
          metadata: completeMetadata
        }));
      }
      
      setIsEditing(false);
    } catch (error) {
      setIsEditing(false);
      handleStrictModeError(error, 'save document metadata');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedName(document?.name || '');
    setEditedMetadata({});
    setIsEditing(false);
  };

  const handleEdit = () => {
    setEditedName(document?.name || '');
    
    // Initialize edited metadata with current values for configured fields
    const initialMetadata = {};
    metadataFields.forEach(field => {
      initialMetadata[field.name] = document?.metadata?.[field.name] || '';
    });
    setEditedMetadata(initialMetadata);
    
    setIsEditing(true);
  };

  const handleDeleteClick = () => {
    openDeleteModal();
  };

  const handleDelete = async () => {
    setDeleting(true);
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
      handleStrictModeError(error, 'delete document');
    } finally {
      setDeleting(false);
      closeDeleteModal();
    }
  };

  return (
    <Stack spacing="lg" mt="md">
      <Paper withBorder p="md">
        <Stack spacing="md">
          <Group justify="space-between" align="center">
            <Title order={3}>Document Information</Title>
            {!isEditing && (
              <Button
                leftSection={<IconEdit size={16} />}
                variant="light"
                size="sm"
                onClick={handleEdit}
              >
                Edit
              </Button>
            )}
          </Group>

          <Divider />

          {isEditing ? (
            <Stack spacing="md">
              <TextInput
                label="Document Name"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                placeholder="Enter document name"
                required
              />

              {metadataFields.map((field) => (
                <TextInput
                  key={field.name}
                  label={field.name}
                  value={editedMetadata[field.name] || ''}
                  onChange={(e) => setEditedMetadata(prev => ({
                    ...prev,
                    [field.name]: e.target.value
                  }))}
                  placeholder={`Enter ${field.name}`}
                />
              ))}

              <Group justify="space-between">
                <Button
                  variant="outline"
                  color="gray"
                  leftSection={<IconTrash size={16} />}
                  onClick={handleDeleteClick}
                  disabled={saving || deleting}
                  style={{ opacity: 0.7 }}
                >
                  Delete
                </Button>
                <Group>
                  <Button
                    variant="outline"
                    leftSection={<IconX size={16} />}
                    onClick={handleCancel}
                    disabled={saving || deleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    leftSection={<IconDeviceFloppy size={16} />}
                    onClick={handleSave}
                    loading={saving}
                    disabled={!editedName.trim() || deleting}
                  >
                    Save Changes
                  </Button>
                </Group>
              </Group>
            </Stack>
          ) : (
            <Stack spacing="md">
              <div>
                <Text size="sm" fw={700} mb="xs">Name</Text>
                <Text>{document?.name}</Text>
              </div>

              <div>
                <Text size="sm" fw={700} mb="xs">Document ID</Text>
                <Text size="sm" ff="monospace">{document?.id}</Text>
              </div>

              {/* Show configured metadata fields */}
              {metadataFields.map((field) => {
                const value = document?.metadata?.[field.name]
                return (
                    <div key={field.name}>
                      <Text size="sm" fw={700} mb="xs">{field.name}</Text>
                      <Text c={value ? '' : 'dimmed'}>{value || 'Not set'}</Text>
                    </div>
                )
              })}

              {metadataFields.length === 0 && (!document?.metadata || Object.keys(document.metadata).length === 0) && (
                <Alert icon={<IconInfoCircle size={16} />} color="blue">
                  No metadata fields configured for this project. You can add metadata fields 
                  in the project settings.
                </Alert>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>

      <Modal
        opened={deleteModalOpened}
        onClose={closeDeleteModal}
        title="Delete Document"
        size="md"
        centered
      >
        <Stack spacing="md">
          <Alert
            icon={<IconAlertTriangle size={16} />}
            title="This action is irreversible"
            color="red"
            variant="light"
          >
            <Text size="sm">
              You are about to permanently delete the document <strong>"{document?.name}"</strong> and 
              all of its associated data including annotations and text content.
            </Text>
            <Text size="sm" mt="xs">
              This action cannot be undone.
            </Text>
          </Alert>

          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={closeDeleteModal}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={handleDelete}
              loading={deleting}
              leftSection={<IconTrash size={16} />}
            >
              {deleting ? 'Deleting...' : 'Delete Document'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
};