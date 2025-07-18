import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Container, 
  Title, 
  Paper, 
  Text, 
  Button, 
  Stack,
  Alert,
  Loader,
  Center,
  Group,
  SimpleGrid
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus } from '@tabler/icons-react';
import IconLogout from '@tabler/icons-react/dist/esm/icons/IconLogout.mjs';

export const ProjectList = () => {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { client, user, logout } = useAuth();

  const fetchProjects = async () => {
    try {
      setLoading(true);
      if (!client) {
        throw new Error('Not authenticated');
      }
      const projectList = await client.projects.list();
      setProjects(projectList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Redirect to login instead of showing error
        logout();
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

  const handleProjectClick = (projectId) => {
    navigate(`/projects/${projectId}`);
  };

  if (loading) {
    return (
      <Container size="lg" py="xl">
        <Center>
          <Stack align="center" spacing="md">
            <Loader size="lg" />
            <Text>Loading projects...</Text>
          </Stack>
        </Center>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack spacing="xl">
        <Group justify="space-between">
          <div>
            <Title order={1}>Projects</Title>
          </div>
          <Button 
            leftSection={<IconPlus size={16} />}
            onClick={() => navigate('/projects/new')}
          >
            New Project
          </Button>
        </Group>

        {error && (
          <Alert color="red" title="Error">
            {error}
          </Alert>
        )}

        {projects.length === 0 ? (
          <Paper shadow="sm" p="xl" radius="md">
            <Center>
              <Stack align="center" spacing="md">
                <Text size="lg" color="dimmed">No projects found</Text>
                <Text size="sm" color="dimmed">
                  You don't have access to any projects yet.
                </Text>
              </Stack>
            </Center>
          </Paper>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
            {projects.map(project => (
              <Paper 
                key={project.id} 
                shadow="sm" 
                p="md" 
                radius="md"
                style={{ cursor: 'pointer' }}
                onClick={() => handleProjectClick(project.id)}
              >
                <Stack spacing="xs">
                  <Title order={4}>{project.name}</Title>
                  <Text size="sm" c="dimmed">
                    ID: {project.id}
                  </Text>
                  {project.documents && (
                    <Text size="sm" c="dimmed">
                      {project.documents.length} document{project.documents.length !== 1 ? 's' : ''}
                    </Text>
                  )}
                </Stack>
              </Paper>
            ))}
          </SimpleGrid>
        )}
      </Stack>
    </Container>
  );
};