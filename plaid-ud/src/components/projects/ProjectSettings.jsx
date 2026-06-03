import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { Container, Group, Title, Button, Tabs } from '@mantine/core';
import { ProjectConfiguration } from './ProjectConfiguration.jsx';
import { ProjectManagement } from './ProjectManagement.jsx';

// Single settings view with tabs, merging UD layer configuration and user/
// permission management. The two tabs stay route-backed (`/configuration` and
// `/management`) so deep links and the editor's auto-redirect keep working;
// the active tab is derived from the path. Only the active panel mounts, so
// each child fetches lazily.
export const ProjectSettings = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname.endsWith('/management') ? 'management' : 'configuration';

  return (
    <Container size="lg" py="md">
      <Group justify="space-between" align="center" mb="lg">
        <Title order={1}>Project Settings</Title>
        <Button component={Link} to={`/projects/${projectId}/documents`} variant="default">
          Back to Documents
        </Button>
      </Group>

      <Tabs value={active} onChange={(v) => navigate(`/projects/${projectId}/${v}`)} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="configuration">UD Configuration</Tabs.Tab>
          <Tabs.Tab value="management">Users &amp; Permissions</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="configuration">
          <ProjectConfiguration embedded />
        </Tabs.Panel>
        <Tabs.Panel value="management">
          <ProjectManagement embedded />
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
};
