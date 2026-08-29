import { Link, useLocation } from 'react-router-dom';
import { Tabs, Breadcrumbs, Anchor, Text, Group } from '@mantine/core';
import { EntityAvatar } from '../common/EntityAvatar.jsx';

export const DocumentTabs = ({ projectId, documentId, project, document }) => {
  const location = useLocation();
  const currentPath = location.pathname;
  const active = currentPath.includes('/annotate')
    ? 'annotate'
    : currentPath.includes('/export')
      ? 'export'
      : 'edit';
  const base = `/projects/${projectId}/documents/${documentId}`;

  return (
    <>
      <Breadcrumbs mb="md">
        <Anchor component={Link} to="/projects" size="sm">
          Projects
        </Anchor>
        <Anchor component={Link} to={`/projects/${projectId}/documents`} size="sm">
          <Group gap={6} wrap="nowrap">
            <EntityAvatar id={projectId} size={16} />
            {project?.name || 'Loading...'}
          </Group>
        </Anchor>
        <Group gap={6} wrap="nowrap">
          <EntityAvatar id={documentId} size={16} />
          <Text size="sm" c="dimmed">
            {document?.name || 'Loading...'}
          </Text>
        </Group>
      </Breadcrumbs>

      {/* Real links rather than an `onChange`, so middle-click and cmd-click
          open the tab in a new browser tab. Same shape as `ProjectTabs`. */}
      <Tabs value={active} mb="lg">
        <Tabs.List>
          <Tabs.Tab value="edit" component={Link} to={`${base}/edit`}>
            Text Editor
          </Tabs.Tab>
          <Tabs.Tab value="annotate" component={Link} to={`${base}/annotate`}>
            Annotate
          </Tabs.Tab>
          <Tabs.Tab value="export" component={Link} to={`${base}/export`}>
            Export
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
    </>
  );
};
