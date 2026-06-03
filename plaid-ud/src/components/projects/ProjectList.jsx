import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Title, Button, Alert, Paper, Stack, Group, Text, Box, Center, Loader, ActionIcon, Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext';
import { ProjectForm } from './ProjectForm';
import { EntityAvatar } from '../common/EntityAvatar.jsx';
import { confirmDelete, notifySuccess, notifyError } from '../../utils/feedback.jsx';
import classes from '../common/listRow.module.css';

export const ProjectList = () => {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const { getClient } = useAuth();
  const navigate = useNavigate();

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }
      const projectList = await client.projects.list();
      setProjects(projectList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Redirect to login instead of showing error
        window.location.href = '/login';
        return;
      }
      setError('Failed to load projects');
      console.error('Error fetching projects:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const handleDelete = (projectId, projectName) => {
    confirmDelete({
      title: 'Delete project',
      message: `Are you sure you want to delete project "${projectName}"? This action cannot be undone.`,
      onConfirm: async () => {
        // Optimistic remove so the UI doesn't gate on the server round-trip.
        // Snapshot for rollback if the server rejects.
        const previousProjects = projects;
        setProjects(prev => prev.filter(p => p.id !== projectId));
        try {
          await getClient().projects.delete(projectId);
          notifySuccess(`Deleted "${projectName}"`);
        } catch (err) {
          setProjects(previousProjects);
          notifyError(err.message || 'Unknown error', 'Failed to delete project');
          console.error('Error deleting project:', err);
        }
      },
    });
  };

  const handleProjectCreated = () => {
    setShowCreateForm(false);
    fetchProjects(); // Refresh the list
  };

  if (loading) {
    return <Center py={48}><Loader /></Center>;
  }

  return (
    <>
      <Group justify="space-between" mb="lg">
        <Title order={2}>Projects</Title>
        <Button color="dark" leftSection={<IconPlus size={16} />} onClick={() => setShowCreateForm(true)}>
          New UD Project
        </Button>
      </Group>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      <ProjectForm
        isOpen={showCreateForm}
        onClose={() => setShowCreateForm(false)}
        onSuccess={handleProjectCreated}
      />

      {projects.length === 0 ? (
        <Center py={48}>
          <Text c="dimmed">No projects yet. Create your first UD project to get started!</Text>
        </Center>
      ) : (
        <Paper withBorder radius="md">
          <Stack gap={0}>
            {projects.map((project, i) => (
              <Box
                key={project.id}
                className={classes.row}
                onClick={() => navigate(`/projects/${project.id}/documents`)}
                p="md"
                style={{ borderTop: i ? '1px solid var(--mantine-color-gray-2)' : undefined }}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap">
                    <EntityAvatar id={project.id} size={36} />
                    <div>
                    <Text fw={500} size="lg">{project.name}</Text>
                    <Group gap="md" mt={4}>
                      <Text size="sm" c="dimmed">ID: {project.id}</Text>
                      {project.documents && (
                        <Text size="sm" c="dimmed">
                          {project.documents.length} document{project.documents.length !== 1 ? 's' : ''}
                        </Text>
                      )}
                    </Group>
                    </div>
                  </Group>
                  <Tooltip label="Delete project">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={(e) => { e.stopPropagation(); handleDelete(project.id, project.name); }}
                    >
                      <IconTrash size={18} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </>
  );
};
