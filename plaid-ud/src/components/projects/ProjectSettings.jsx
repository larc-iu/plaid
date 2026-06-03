import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { Container, Title, Tabs, Breadcrumbs, Anchor, Text } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext.jsx';
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
  const { getClient } = useAuth();
  const [projectName, setProjectName] = useState('');
  const active = location.pathname.endsWith('/management') ? 'management' : 'configuration';

  // Just the name, for the breadcrumb (the active tab's child fetches the rest).
  useEffect(() => {
    const client = getClient();
    if (!client) return;
    client.projects.get(projectId).then(p => setProjectName(p?.name || '')).catch(() => {});
  }, [projectId, getClient]);

  return (
    <Container size="lg" py="md">
      <Breadcrumbs mb="md">
        <Anchor component={Link} to="/projects" size="sm">Projects</Anchor>
        <Anchor component={Link} to={`/projects/${projectId}/documents`} size="sm">
          {projectName || 'Loading...'}
        </Anchor>
        <Text size="sm" c="dimmed">Project Settings</Text>
      </Breadcrumbs>

      <Title order={1} mb="lg">Project Settings</Title>

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
