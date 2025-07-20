import { useState } from 'react';
import { 
  Stack, 
  Title, 
  Text, 
  Paper,
  TextInput,
  Button,
  Group,
  Alert,
  Divider
} from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import IconEdit from '@tabler/icons-react/dist/esm/icons/IconEdit.mjs';
import IconDeviceFloppy from '@tabler/icons-react/dist/esm/icons/IconDeviceFloppy.mjs';
import IconX from '@tabler/icons-react/dist/esm/icons/IconX.mjs';

export const DocumentMetadata = ({ document, parsedDocument, project, client, onDocumentUpdated }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(document?.name || '');
  const [editedMetadata, setEditedMetadata] = useState({});
  const [saving, setSaving] = useState(false);

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
      console.error('Failed to save metadata:', error);
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
                  disabled={!editedName.trim()}
                >
                  Save Changes
                </Button>
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
    </Stack>
  );
};