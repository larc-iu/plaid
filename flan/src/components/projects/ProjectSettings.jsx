import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Title, 
  Text, 
  Button, 
  Stack,
  Paper,
  Modal,
  TextInput,
  Alert,
  Group
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconAlertTriangle from '@tabler/icons-react/dist/esm/icons/IconAlertTriangle.mjs';
import { DocumentMetadataSettings } from './settings/DocumentMetadataSettings.jsx';
import { OrthographiesSettings } from './settings/OrthographiesSettings.jsx';
import { FieldsSettings } from './settings/FieldsSettings.jsx';
import { VocabularySettings } from './settings/VocabularySettings.jsx';

export const ProjectSettings = ({ 
  project, 
  projectId, 
  client 
}) => {
  const navigate = useNavigate();
  const [deleteModalOpened, { open: openDeleteModal, close: closeDeleteModal }] = useDisclosure(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteProject = async () => {
    if (confirmationText.toLowerCase() !== project.name.toLowerCase()) {
      notifications.show({
        title: 'Invalid confirmation',
        message: 'Project name does not match. Please type the exact project name.',
        color: 'red'
      });
      return;
    }

    try {
      setIsDeleting(true);
      if (!client) {
        throw new Error('Not authenticated');
      }
      await client.projects.delete(projectId);
      
      notifications.show({
        title: 'Project deleted',
        message: `Project "${project.name}" has been successfully deleted.`,
        color: 'green'
      });
      
      // Navigate back to projects list
      navigate('/projects');
    } catch (err) {
      console.error('Error deleting project:', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to delete project. Please try again.',
        color: 'red'
      });
    } finally {
      setIsDeleting(false);
      closeDeleteModal();
    }
  };

  const handleDeleteClick = () => {
    setConfirmationText('');
    openDeleteModal();
  };

  const isConfirmationValid = confirmationText.toLowerCase() === project.name.toLowerCase();

  return (
    <>
      <Stack spacing="lg" mt="md">
        {/* Document Metadata Configuration */}
        <DocumentMetadataSettings 
          projectId={projectId} 
          client={client} 
        />
        
        {/* Orthographies Configuration */}
        <OrthographiesSettings 
          projectId={projectId} 
          client={client} 
        />
        
        {/* Fields Configuration */}
        <FieldsSettings 
          projectId={projectId} 
          client={client} 
        />
        
        {/* Vocabulary Configuration */}
        <VocabularySettings 
          projectId={projectId} 
          client={client} 
        />
        
        <Paper withBorder p="md">
          <Title order={2} mb="md">Danger Zone</Title>
          <Text size="sm" mb="md" c="dimmed">
            These actions are irreversible. Please proceed with caution.
          </Text>
          
          <Stack spacing="md">
            <div>
              <Text size="sm" fw={500} mb="xs">Delete Project</Text>
              <Text size="xs" c="dimmed" mb="md">
                Permanently delete this project and all of its documents, annotations, and associated data. 
                This action cannot be undone.
              </Text>
              
              <Button
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={handleDeleteClick}
              >
                Delete Project
              </Button>
            </div>
          </Stack>
        </Paper>
      </Stack>

      <Modal
        opened={deleteModalOpened}
        onClose={closeDeleteModal}
        title="Delete Project"
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
              You are about to permanently delete the project <strong>"{project.name}"</strong> and 
              all of its associated data including documents, annotations, and configuration.
            </Text>
            <Text size="sm" mt="xs">
              This action cannot be undone.
            </Text>
          </Alert>

          <div>
            <Text size="sm" mb="xs">
              To confirm deletion, please type the project name <strong>{project.name}</strong> below:
            </Text>
            <TextInput
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.currentTarget.value)}
              placeholder="Enter project name"
              error={confirmationText && !isConfirmationValid ? 'Project name does not match' : null}
            />
          </div>

          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={closeDeleteModal}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={handleDeleteProject}
              disabled={!isConfirmationValid || isDeleting}
              loading={isDeleting}
              leftSection={<IconTrash size={16} />}
            >
              {isDeleting ? 'Deleting...' : 'Delete Project'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
};