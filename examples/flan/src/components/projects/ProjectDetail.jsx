import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Container, 
  Title, 
  Text, 
  Stack,
  Alert,
  Loader,
  Center,
  Breadcrumbs,
  Anchor,
  Tabs
} from '@mantine/core';
import { IconFile, IconUsers, IconSettings } from '@tabler/icons-react';
import { DocumentList } from './DocumentList';
import { AccessManagement } from './AccessManagement';
import { ProjectSettings } from './ProjectSettings';

export const ProjectDetail = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, getClient } = useAuth();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('documents');

  // Unified data fetching function with flexible options
  const fetchData = async (options = {}) => {
    const {
      includeProject = false,
      includeUsers = false,
      includeDocuments = false,
      showLoadingSpinner = false
    } = options;

    try {
      if (showLoadingSpinner) {
        setLoading(true);
      }
      
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      // Fetch project data (with documents if requested)
      if (includeProject) {
        const projectData = await client.projects.get(projectId, includeDocuments);
        setProject(projectData);
        
        if (includeDocuments) {
          setDocuments(projectData.documents || []);
        }
      }
      
      // Fetch users if requested and user has permission
      if (includeUsers && (user.isAdmin || project?.maintainers?.includes(user.id))) {
        const usersData = await client.users.list();
        setUsers(usersData);
      }
      
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        navigate('/login');
        return;
      }
      setError('Failed to load data');
      console.error('Error fetching data:', err);
    } finally {
      if (showLoadingSpinner) {
        setLoading(false);
      }
    }
  };

  // Initial data load with full loading state
  const fetchInitialData = () => fetchData({
    includeProject: true,
    includeUsers: true,
    includeDocuments: true,
    showLoadingSpinner: true
  });

  // Update project data without loading spinner
  const updateProjectData = () => fetchData({
    includeProject: true,
    includeDocuments: true
  });

  // Update users list without loading spinner
  const updateUsersData = () => fetchData({
    includeUsers: true
  });

  useEffect(() => {
    fetchInitialData();
  }, [projectId]);

  // Check if project needs setup and redirect if necessary
  useEffect(() => {
    if (project && !project.config?.flan?.initialized) {
      navigate(`/projects/${projectId}/setup`);
    }
  }, [project, projectId, navigate]);

  // Check if current user can manage this project
  const canManageProject = () => {
    if (!user || !project) return false;
    return user.isAdmin || project.maintainers?.includes(user.id);
  };

  const breadcrumbItems = [
    { title: 'Projects', href: '/projects' },
    { title: project?.name || 'Loading...', href: null }
  ].map((item, index) => (
    item.href ? (
      <Anchor key={index} onClick={() => navigate(item.href)}>
        {item.title}
      </Anchor>
    ) : (
      <Text key={index}>{item.title}</Text>
    )
  ));

  if (loading) {
    return (
      <Container size="lg" py="xl">
        <Center>
          <Stack align="center" spacing="md">
            <Loader size="lg" />
            <Text>Loading project...</Text>
          </Stack>
        </Center>
      </Container>
    );
  }

  if (error) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Error">
          {error}
        </Alert>
      </Container>
    );
  }

  if (!project) {
    return (
      <Container size="lg" py="xl">
        <Alert color="red" title="Project Not Found">
          The requested project could not be found.
        </Alert>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack spacing="lg">
        <Breadcrumbs>
          {breadcrumbItems}
        </Breadcrumbs>

        <div>
          <Title order={1} mb="xs">{project.name}</Title>
          <Text c="dimmed" size="xs" mb="lg">{project.id}</Text>
        </div>

        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            <Tabs.Tab value="documents" leftSection={<IconFile size={16} />}>
              Document List
            </Tabs.Tab>
            {canManageProject() && (
              <Tabs.Tab value="management" leftSection={<IconUsers size={16} />}>
                Access Management
              </Tabs.Tab>
            )}
            {canManageProject() && (
              <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
                Settings
              </Tabs.Tab>
            )}
          </Tabs.List>

          <Tabs.Panel value="documents">
            <DocumentList documents={documents} />
          </Tabs.Panel>

          {canManageProject() && (
            <Tabs.Panel value="management">
              <AccessManagement
                project={project}
                users={users}
                user={user}
                projectId={projectId}
                getClient={getClient}
                onDataUpdate={updateProjectData}
                onUsersUpdate={updateUsersData}
              />
            </Tabs.Panel>
          )}

          {canManageProject() && (
            <Tabs.Panel value="settings">
              <ProjectSettings
                project={project}
                projectId={projectId}
                getClient={getClient}
              />
            </Tabs.Panel>
          )}
        </Tabs>
      </Stack>
    </Container>
  );
};