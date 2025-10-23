import { useState } from 'react';
import { 
  Title, 
  Text, 
  Stack,
  Center,
  Button,
  Modal,
  TextInput,
  Group,
  Textarea
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { notifications } from '@mantine/notifications';
import IconPlus from '@tabler/icons-react/dist/esm/icons/IconPlus.mjs';

export const DocumentList = ({ documents, projectId, client, onDocumentCreated }) => {
  const [createModalOpened, setCreateModalOpened] = useState(false);
  const [documentName, setDocumentName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const handleDocumentClick = (document) => {
    // Navigate to document detail page
    window.location.href = `#/projects/${projectId}/documents/${document.id}`;
  };

  const handleCreateDocument = async () => {
    if (!documentName.trim()) {
      notifications.show({
        title: 'Error',
        message: 'Document name is required',
        color: 'red'
      });
      return;
    }

    setIsCreating(true);
    try {
      if (!client) {
        throw new Error('Authentication required');
      }

      const newDocument = await client.documents.create(projectId, documentName.trim());

      // Get the project data to find the primary text layer
      const projectData = await client.projects.get(projectId);
      const primaryTextLayer = projectData?.textLayers?.find(layer => layer.config?.plaid?.primary);

      if (primaryTextLayer) {
        // Create a blank text for the new document
        await client.texts.create(primaryTextLayer.id, newDocument.id, '', {});
      }

      notifications.show({
        title: 'Success',
        message: `Document "${documentName}" created successfully`,
        color: 'green'
      });

      // Reset form
      setDocumentName('');
      setCreateModalOpened(false);

      // Notify parent component with the document name we know it should have
      if (onDocumentCreated) {
        onDocumentCreated({
          ...newDocument,
          name: documentName.trim() // Ensure the name is set optimistically
        });
      }
    } catch (error) {
      console.error('Failed to create document:', error);
      notifications.show({
        title: 'Error',
        message: `Failed to create document: ${error.message}`,
        color: 'red'
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Stack spacing="md" mt="md">
      <Group justify="space-between" align="center">
        <Title order={2}>Documents</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => setCreateModalOpened(true)}
        >
          Create Document
        </Button>
      </Group>
      
      {documents.length === 0 ? (
        <Center py="xl">
          <Stack align="center" spacing="md">
            <Text size="lg" c="dimmed">No documents found</Text>
            <Text size="sm" c="dimmed">
              This project doesn't have any documents yet.
            </Text>
          </Stack>
        </Center>
      ) : (
        <DataTable
          textSelectionDisabled
          withTableBorder
          withRowBorders
          highlightOnHover
          columns={[
            { 
              accessor: 'name', 
              title: 'Document Name',
              width: '70%'
            },
            { 
              accessor: 'id', 
              title: 'ID',
              width: '30%',
              render: ({ id }) => (
                <Text size="sm" c="dimmed">{id}</Text>
              )
            }
          ]}
          records={documents.sort((a, b) => a.name.localeCompare(b.name))}
          onRowClick={({ record }) => handleDocumentClick(record)}
          sx={{
            '& tbody tr': {
              cursor: 'pointer'
            }
          }}
        />
      )}

      {/* Create Document Modal */}
      <Modal
        opened={createModalOpened}
        onClose={() => setCreateModalOpened(false)}
        title="Create New Document"
        size="md"
      >
        <Stack spacing="md">
          <TextInput
            label="Document Name"
            placeholder="Enter document name"
            value={documentName}
            onChange={(event) => setDocumentName(event.currentTarget.value)}
            required
          />
          <Group justify="flex-end">
            <Button
              variant="outline"
              onClick={() => setCreateModalOpened(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateDocument}
              loading={isCreating}
              disabled={!documentName.trim()}
            >
              Create Document
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
};