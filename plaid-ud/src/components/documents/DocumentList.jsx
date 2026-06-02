import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Title, Button, Alert, Paper, Stack, Group, Text, Box, Center, Loader,
  ActionIcon, Tooltip, Breadcrumbs, Anchor,
} from '@mantine/core';
import { IconPlus, IconTrash, IconPencil, IconUpload, IconSettings } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentForm } from './DocumentForm';
import { ImportModal } from './ImportModal';
import { confirmDelete, notifySuccess, notifyError } from '../../utils/feedback.jsx';
import classes from '../common/listRow.module.css';

export const DocumentList = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const { user, getClient } = useAuth();

  const fetchProjectAndDocuments = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }

      // Fetch project with documents
      const projectData = await client.projects.get(projectId, true);
      setProject(projectData);
      setDocuments(projectData.documents || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Redirect to login instead of showing error
        window.location.href = '/login';
        return;
      }
      setError('Failed to load project and documents');
      console.error('Error fetching project:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjectAndDocuments();
  }, [projectId]);

  const handleDelete = (documentId, documentName) => {
    confirmDelete({
      title: 'Delete document',
      message: `Are you sure you want to delete document "${documentName}"? This action cannot be undone.`,
      onConfirm: async () => {
        try {
          await getClient().documents.delete(documentId);
          notifySuccess(`Deleted "${documentName}"`);
          await fetchProjectAndDocuments(); // Refresh the list
        } catch (err) {
          notifyError(err.message || 'Unknown error', 'Failed to delete document');
          console.error('Error deleting document:', err);
        }
      },
    });
  };

  const handleDocumentCreated = () => {
    setShowCreateForm(false);
    fetchProjectAndDocuments(); // Refresh the list
  };

  const handleImportSuccess = () => {
    setShowImportModal(false);
    fetchProjectAndDocuments(); // Refresh the list
  };

  // Check if user can manage this project (admin or maintainer)
  const canManageProject = () => {
    if (!user || !project) return false;
    return user.isAdmin || project.maintainers?.includes(user.id);
  };

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  if (!project) {
    return <Alert color="red">Project not found</Alert>;
  }

  const sortedDocuments = [...documents].sort((d1, d2) => (d1.name < d2.name ? -1 : d1.name > d2.name ? 1 : 0));

  return (
    <>
      <Breadcrumbs mb="lg">
        <Anchor component={Link} to="/projects" size="sm">Projects</Anchor>
        <Text size="sm" c="dimmed">{project.name}</Text>
      </Breadcrumbs>

      <Group justify="space-between" mb="lg">
        <Title order={2}>Documents in {project.name}</Title>
        <Group gap="sm">
          {canManageProject() && (
            <Button
              component={Link}
              to={`/projects/${projectId}/management`}
              color="grape"
              leftSection={<IconSettings size={16} />}
            >
              Project Management
            </Button>
          )}
          <Button variant="default" leftSection={<IconUpload size={16} />} onClick={() => setShowImportModal(true)}>
            Import
          </Button>
          <Button color="dark" leftSection={<IconPlus size={16} />} onClick={() => setShowCreateForm(true)}>
            New Document
          </Button>
        </Group>
      </Group>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      <DocumentForm
        projectId={projectId}
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onSuccess={handleDocumentCreated}
      />

      <ImportModal
        projectId={projectId}
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={handleImportSuccess}
      />

      {documents.length === 0 ? (
        <Center py={48}>
          <Text c="dimmed">No documents yet. Create your first document to start annotating!</Text>
        </Center>
      ) : (
        <Paper withBorder radius="md">
          <Stack gap={0}>
            {sortedDocuments.map((document, i) => (
              <Box
                key={document.id}
                className={classes.row}
                onClick={() => navigate(`/projects/${projectId}/documents/${document.id}/annotate`)}
                p="md"
                style={{ borderTop: i ? '1px solid var(--mantine-color-gray-2)' : undefined }}
              >
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={500} size="lg">{document.name}</Text>
                    <Text size="sm" c="dimmed" mt={4}>ID: {document.id}</Text>
                  </div>
                  <Group gap="xs" wrap="nowrap">
                    <Tooltip label="Edit text">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/projects/${projectId}/documents/${document.id}/edit`);
                        }}
                      >
                        <IconPencil size={18} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete document">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={(e) => { e.stopPropagation(); handleDelete(document.id, document.name); }}
                      >
                        <IconTrash size={18} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </>
  );
};
