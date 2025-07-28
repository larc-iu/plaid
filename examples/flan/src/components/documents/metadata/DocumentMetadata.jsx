import React from 'react';
import { useSnapshot } from 'valtio';
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
import { useMetadataOperations } from './useMetadataOperations.js';
import documentsStore from '../../../stores/documentsStore';

export function DocumentMetadata({ projectId, documentId, reload, client }) {
  const storeSnap = useSnapshot(documentsStore);
  const docSnap = storeSnap[projectId]?.[documentId];
  const isViewingHistorical = docSnap?.ui?.history?.viewingHistorical || false;
  const ops = useMetadataOperations(projectId, documentId, reload, client);

  return (
    <Stack spacing="lg" mt="md">
      <Paper withBorder p="md">
        <Stack spacing="md">
          <Group justify="space-between" align="center">
            <Title order={3}>Document Information</Title>
            {!ops.isEditing && !isViewingHistorical && (
              <Button
                leftSection={<IconEdit size={16} />}
                variant="light"
                size="sm"
                onClick={ops.handleEdit}
              >
                Edit
              </Button>
            )}
          </Group>

          <Divider />

          {ops.isEditing ? (
            <Stack spacing="md">
              <TextInput
                label="Document Name"
                value={ops.editedName}
                onChange={(e) => ops.updateEditedName(e.target.value)}
                placeholder="Enter document name"
                required
              />

              {ops.metadataFields.map((field) => (
                <TextInput
                  key={field.name}
                  label={field.name}
                  value={ops.editedMetadata[field.name] || ''}
                  onChange={(e) => ops.updateEditedMetadata(field.name, e.target.value)}
                  placeholder={`Enter ${field.name}`}
                />
              ))}

              <Group justify="space-between">
                <Button
                  variant="outline"
                  color="gray"
                  leftSection={<IconTrash size={16} />}
                  onClick={ops.handleDeleteClick}
                  disabled={ops.saving || ops.deleting}
                  style={{ opacity: 0.7 }}
                >
                  Delete
                </Button>
                <Group>
                  <Button
                    variant="outline"
                    leftSection={<IconX size={16} />}
                    onClick={ops.handleCancel}
                    disabled={ops.saving || ops.deleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    leftSection={<IconDeviceFloppy size={16} />}
                    onClick={ops.handleSave}
                    loading={ops.saving}
                    disabled={!ops.editedName.trim() || ops.deleting}
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
                <Text>{ops.document.name}</Text>
              </div>

              <div>
                <Text size="sm" fw={700} mb="xs">Document ID</Text>
                <Text size="sm" ff="monospace">{ops.document.id}</Text>
              </div>

              {/* Show configured metadata fields */}
              {ops.metadataFields.map((field) => {
                const value = ops.document.metadata[field.name]
                return (
                    <div key={field.name}>
                      <Text size="sm" fw={700} mb="xs">{field.name}</Text>
                      <Text c={value ? '' : 'dimmed'}>{value || 'Not set'}</Text>
                    </div>
                )
              })}

              {ops.metadataFields.length === 0 && (!ops.document.metadata || Object.keys(ops.document.metadata).length === 0) && (
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
        opened={ops.deleteModalOpen}
        onClose={ops.handleCloseDeleteModal}
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
              You are about to permanently delete the document <strong>"{ops.document.name}"</strong> and 
              all of its associated data including annotations and text content.
            </Text>
            <Text size="sm" mt="xs">
              This action cannot be undone.
            </Text>
          </Alert>

          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={ops.handleCloseDeleteModal}
              disabled={ops.deleting}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={ops.handleDelete}
              loading={ops.deleting}
              leftSection={<IconTrash size={16} />}
            >
              {ops.deleting ? 'Deleting...' : 'Delete Document'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
};