import { Link, useLocation } from 'react-router-dom';
import { Tabs, Breadcrumbs, Anchor, Text, Group } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { canManageProject } from '../../utils/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { EntityAvatar } from '../common/EntityAvatar.jsx';

// Shared top tab bar for the four project-level views (Documents / Search /
// Project Settings / Import & Export), mirroring the per-document `DocumentTabs`.
// Each tab is route-backed; only a `<Tabs.List>` is rendered (no panels) — each
// route renders its own body. `project` is the full object every page already
// fetches (carries layer config for `getUdLayerInfo`); it may be null mid-load,
// which all the gating below tolerates.
export const ProjectTabs = ({ projectId, project }) => {
  const location = useLocation();
  const { user } = useAuth();

  const canManage = canManageProject(project, user);
  const configured = getUdLayerInfo(project).isConfigured;
  // Settings assumes a configured project; an unconfigured one routes to the
  // standalone layer-setup page instead (matches DocumentList's old behavior).
  const settingsTo = configured
    ? `/projects/${projectId}/management`
    : `/projects/${projectId}/configuration`;

  const p = location.pathname;
  const active = p.endsWith('/search')
    ? 'search'
    : p.endsWith('/import-export')
      ? 'import-export'
      : /\/(management|customization|services|tokens|general|configuration)$/.test(p)
        ? 'settings'
        : 'documents';

  return (
    <>
      <Breadcrumbs mb="md">
        <Anchor component={Link} to="/projects" size="sm">
          Projects
        </Anchor>
        <Group gap={6} wrap="nowrap">
          <EntityAvatar id={projectId} size={16} />
          <Text size="sm" c="dimmed">
            {project?.name || 'Loading...'}
          </Text>
        </Group>
      </Breadcrumbs>

      {/* Each tab is a real link (no `onChange`): the anchor does the
          navigating, so middle-click and cmd-click open a tab in a new browser
          tab, and Mantine's arrow-key handler clicks the focused one for us. */}
      <Tabs value={active} mb="lg">
        <Tabs.List>
          <Tabs.Tab value="documents" component={Link} to={`/projects/${projectId}/documents`}>
            Documents
          </Tabs.Tab>
          <Tabs.Tab value="search" component={Link} to={`/projects/${projectId}/search`}>
            Search
          </Tabs.Tab>
          {canManage && (
            <Tabs.Tab value="settings" component={Link} to={settingsTo}>
              Project Settings
            </Tabs.Tab>
          )}
          <Tabs.Tab
            value="import-export"
            component={Link}
            to={`/projects/${projectId}/import-export`}
          >
            Import &amp; Export
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
    </>
  );
};
