import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Title, Tabs } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ProjectCustomization } from './ProjectCustomization.jsx';
import { ProjectManagement } from './ProjectManagement.jsx';
import { ProjectAccessTokens } from './ProjectAccessTokens.jsx';
import { ProjectGeneral } from './ProjectGeneral.jsx';
import { ProjectServicesSettings } from './ProjectServicesSettings.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';

// Single settings view with tabs: user/permission management, UD customization
// (vocab/colors), services (registry + defaults), API access tokens, and
// general project settings (tokenizer locale + delete). Each tab is
// route-backed (`/management`, `/customization`, `/services`, `/tokens`,
// `/general`) so deep links keep working; the active tab is derived from the
// path. Only the active panel mounts, so each child fetches lazily. The UD
// layer-structure setup form (ProjectConfiguration) is a separate standalone
// page at `/configuration`, used by the editor's "missing layers" auto-redirect.
export const ProjectSettings = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { getClient } = useAuth();
  const [project, setProject] = useState(null);
  const active = location.pathname.endsWith('/customization') ? 'customization'
    : location.pathname.endsWith('/services') ? 'services'
      : location.pathname.endsWith('/tokens') ? 'tokens'
        : location.pathname.endsWith('/general') ? 'general'
          : 'management';

  // The full project drives ProjectTabs (breadcrumb + permission gating); the
  // active tab's child fetches whatever else it needs.
  useEffect(() => {
    const client = getClient();
    if (!client) return;
    client.projects.get(projectId).then(p => setProject(p)).catch(() => {});
  }, [projectId, getClient]);

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <Title order={1} mb="lg">Project Settings</Title>

      <Tabs
        orientation="vertical"
        value={active}
        onChange={(v) => navigate(`/projects/${projectId}/${v}`)}
        keepMounted={false}
      >
        <Tabs.List style={{ minWidth: 200 }}>
          <Tabs.Tab value="management">Users &amp; Permissions</Tabs.Tab>
          <Tabs.Tab value="customization">UD Customization</Tabs.Tab>
          <Tabs.Tab value="services">Services</Tabs.Tab>
          <Tabs.Tab value="tokens">Access Tokens</Tabs.Tab>
          <Tabs.Tab value="general">General</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="management" pl="lg">
          <ProjectManagement embedded />
        </Tabs.Panel>
        <Tabs.Panel value="customization" pl="lg">
          <ProjectCustomization embedded />
        </Tabs.Panel>
        <Tabs.Panel value="services" pl="lg">
          <ProjectServicesSettings />
        </Tabs.Panel>
        <Tabs.Panel value="tokens" pl="lg">
          <ProjectAccessTokens embedded />
        </Tabs.Panel>
        <Tabs.Panel value="general" pl="lg">
          <ProjectGeneral embedded />
        </Tabs.Panel>
      </Tabs>
    </>
  );
};
