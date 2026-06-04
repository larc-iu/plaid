import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { Container, Title, Tabs, Breadcrumbs, Anchor, Text } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ProjectCustomization } from './ProjectCustomization.jsx';
import { ProjectManagement } from './ProjectManagement.jsx';
import { ProjectGeneral } from './ProjectGeneral.jsx';

// Single settings view with tabs: user/permission management, UD customization
// (vocab/colors), and general project settings (tokenizer locale + delete).
// Each tab is route-backed (`/management`, `/customization`, `/general`) so
// deep links keep working; the active tab is derived from the path. Only the
// active panel mounts, so each child fetches lazily. The UD layer-structure
// setup form (ProjectConfiguration) is a separate standalone page at
// `/configuration`, used by the editor's "missing layers" auto-redirect.
export const ProjectSettings = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { getClient } = useAuth();
  const [projectName, setProjectName] = useState('');
  const active = location.pathname.endsWith('/customization') ? 'customization'
    : location.pathname.endsWith('/general') ? 'general'
      : 'management';

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
          <Tabs.Tab value="management">Users &amp; Permissions</Tabs.Tab>
          <Tabs.Tab value="customization">UD Customization</Tabs.Tab>
          <Tabs.Tab value="general">General</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="management">
          <ProjectManagement embedded />
        </Tabs.Panel>
        <Tabs.Panel value="customization">
          <ProjectCustomization embedded />
        </Tabs.Panel>
        <Tabs.Panel value="general">
          <ProjectGeneral embedded />
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
};
