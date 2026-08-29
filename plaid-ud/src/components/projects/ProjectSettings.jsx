import { useState, useEffect } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { Title, Tabs } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ProjectCustomization } from './ProjectCustomization.jsx';
import { ProjectManagement } from './ProjectManagement.jsx';
import { ProjectAccessTokens } from './ProjectAccessTokens.jsx';
import { ProjectGeneral } from './ProjectGeneral.jsx';
import { ProjectServicesSettings } from './ProjectServicesSettings.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

// Title-bar labels for the settings tabs (match the Tabs below).
const SECTION_TITLES = {
  management: 'Users & Permissions',
  customization: 'UD Customization',
  services: 'Services',
  tokens: 'Access Tokens',
  general: 'General',
};

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
  const location = useLocation();
  const { getClient } = useAuth();
  const [project, setProject] = useState(null);
  const active = location.pathname.endsWith('/customization')
    ? 'customization'
    : location.pathname.endsWith('/services')
      ? 'services'
      : location.pathname.endsWith('/tokens')
        ? 'tokens'
        : location.pathname.endsWith('/general')
          ? 'general'
          : 'management';

  useDocumentTitle(SECTION_TITLES[active], project?.name);

  // The full project drives ProjectTabs (breadcrumb + permission gating); the
  // active tab's child fetches whatever else it needs.
  useEffect(() => {
    const client = getClient();
    if (!client) return;
    client.projects
      .get(projectId)
      .then((p) => setProject(p))
      .catch(() => {});
  }, [projectId, getClient]);

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <Title order={1} mb="lg">
        Project Settings
      </Title>

      {/* Real links rather than an `onChange`: each section is a page of its
          own, so it opens in a new browser tab like any other link. */}
      <Tabs orientation="vertical" value={active} keepMounted={false}>
        <Tabs.List style={{ minWidth: 200 }}>
          {[
            ['management', 'Users & Permissions'],
            ['customization', 'UD Customization'],
            ['services', 'Services'],
            ['tokens', 'Access Tokens'],
            ['general', 'General'],
          ].map(([value, label]) => (
            <Tabs.Tab
              key={value}
              value={value}
              component={Link}
              to={`/projects/${projectId}/${value}`}
            >
              {label}
            </Tabs.Tab>
          ))}
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
