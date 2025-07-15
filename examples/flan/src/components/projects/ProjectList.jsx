import { useState, useEffect } from 'react';
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
  Badge,
  ActionIcon,
  Menu,
  Divider
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import IconDots from '@tabler/icons-react/dist/esm/icons/IconDots.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import IconUsers from '@tabler/icons-react/dist/esm/icons/IconUsers.mjs';
import IconLogout from '@tabler/icons-react/dist/esm/icons/IconLogout.mjs';

export const ProjectList = () => {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { getClient, user, logout } = useAuth();

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

  const handleDelete = async (projectId, projectName) => {
    try {
      const client = getClient();
      await client.projects.delete(projectId);
      notifications.show({
        title: 'Success',
        message: `Project "${projectName}" has been deleted`,
        color: 'green'
      });
      await fetchProjects(); // Refresh the list
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: 'Failed to delete project',
        color: 'red'
      });
      console.error('Error deleting project:', err);
    }
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
        <Group position="apart">
          <div>
            <Title order={1}>Projects</Title>
            <Text color="dimmed">Welcome back, {user?.username}</Text>
          </div>
          <Button
            variant="filled"
            leftSection={<IconLogout size={16} />}
            onClick={logout}
            color="red"
          >
            Logout
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
          <Stack spacing="md">
            {projects.map(project => (
              <Paper key={project.id} shadow="sm" p="lg" radius="md">
                <Group position="apart">
                  <div style={{ flex: 1 }}>
                    <Group spacing="md" mb="xs">
                      <Title order={3}>{project.name}</Title>
                      <Badge variant="light" color="blue">
                        ID: {project.id}
                      </Badge>
                    </Group>
                    
                    {project.documents && (
                      <Text size="sm" color="dimmed">
                        {project.documents.length} document{project.documents.length !== 1 ? 's' : ''}
                      </Text>
                    )}
                  </div>
                  
                  <Menu shadow="md" width={200}>
                    <Menu.Target>
                      <ActionIcon>
                        <IconDots size={16} />
                      </ActionIcon>
                    </Menu.Target>

                    <Menu.Dropdown>
                      <Menu.Item 
                        icon={<IconUsers size={14} />}
                        onClick={() => {
                          // Placeholder for future implementation
                          notifications.show({
                            title: 'Coming Soon',
                            message: 'Document management will be implemented later',
                            color: 'blue'
                          });
                        }}
                      >
                        View Documents
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item 
                        icon={<IconTrash size={14} />}
                        color="red"
                        onClick={() => {
                          if (window.confirm(`Are you sure you want to delete project "${project.name}"? This action cannot be undone.`)) {
                            handleDelete(project.id, project.name);
                          }
                        }}
                      >
                        Delete Project
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
};