import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Tabs, Breadcrumbs, Anchor, Text } from '@mantine/core';

export const DocumentTabs = ({ projectId, documentId, project, document }) => {
  const location = useLocation();
  const navigate = useNavigate();
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
        <Anchor component={Link} to="/projects" size="sm">Projects</Anchor>
        <Anchor component={Link} to={`/projects/${projectId}/documents`} size="sm">
          {project?.name || 'Loading...'}
        </Anchor>
        <Text size="sm" c="dimmed">{document?.name || 'Loading...'}</Text>
      </Breadcrumbs>

      <Tabs value={active} onChange={(value) => navigate(`${base}/${value}`)} mb="lg">
        <Tabs.List>
          <Tabs.Tab value="edit">Text Editor</Tabs.Tab>
          <Tabs.Tab value="annotate">Annotate</Tabs.Tab>
          <Tabs.Tab value="export">Export</Tabs.Tab>
        </Tabs.List>
      </Tabs>
    </>
  );
};
