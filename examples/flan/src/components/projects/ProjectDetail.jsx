import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Container, 
  Title, 
  Text, 
  Button, 
  Stack,
  Alert,
  Loader,
  Center,
  Group,
  Breadcrumbs,
  Anchor
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft } from '@tabler/icons-react';

export const ProjectDetail = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient } = useAuth();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchProjectAndDocuments = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }
      
      // Fetch project with documents (includeDocuments = true)
      const projectData = await client.projects.get(projectId, true);
      setProject(projectData);
      setDocuments(projectData.documents || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        navigate('/login');
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

  const handleDocumentClick = (document) => {
    // TODO: Navigate to document editor/viewer
    notifications.show({
      title: 'Coming Soon',
      message: `Document "${document.name}" selected. Editor will be implemented later.`,
      color: 'blue'
    });
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString();
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
        <Button 
          variant="subtle" 
          leftSection={<IconArrowLeft size={16} />}
          mb="md"
          onClick={() => navigate(-1)}
        >
          Back
        </Button>

        <Breadcrumbs>
          {breadcrumbItems}
        </Breadcrumbs>

        <div>
          <Title order={1} mb="xs">{project.name}</Title>
          <Text c="dimmed" mb="lg">Project ID: {project.id}</Text>
        </div>

        <div>
          <Title order={2} mb="md">Documents</Title>
          
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
                  width: '40%'
                },
                { 
                  accessor: 'id', 
                  title: 'ID',
                  width: '30%',
                  render: ({ id }) => (
                    <Text size="sm" c="dimmed">{id}</Text>
                  )
                },
                { 
                  accessor: 'createdAt', 
                  title: 'Created',
                  width: '15%',
                  render: ({ createdAt }) => (
                    <Text size="sm">{formatDate(createdAt)}</Text>
                  )
                },
                { 
                  accessor: 'modifiedAt', 
                  title: 'Modified',
                  width: '15%',
                  render: ({ modifiedAt }) => (
                    <Text size="sm">{formatDate(modifiedAt)}</Text>
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
        </div>
      </Stack>
    </Container>
  );
};