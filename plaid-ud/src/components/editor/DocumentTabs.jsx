import { Link, useLocation } from 'react-router-dom';
import { Tabs, Breadcrumbs, Anchor, Text, Group } from '@mantine/core';
import { EntityAvatar } from '../common/EntityAvatar.jsx';

// A tab is a link, or — while the editor is busy — an inert button. See the
// note on `Tabs.List` below for why the two can't be the same element.
const tabTarget = (to, disabled) => (disabled ? { disabled: true } : { component: Link, to });

export const DocumentTabs = ({ projectId, documentId, project, document, disabled = false }) => {
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
          open the tab in a new browser tab. Same shape as `ProjectTabs`.

          While the body is busy (reconcile-on-open is repairing the document),
          the tabs become plain disabled buttons instead. Mantine's `disabled`
          only greys out an anchor — it can't stop it navigating — and a tab
          switch mid-repair would drop the user into the Text Editor to
          re-tokenize a document whose heal writes are still in flight, which is
          the thing the spinner exists to prevent. Dropping `component`/`to`
          gives real <button disabled>, so click, cmd-click and keyboard
          activation are all inert. */}
      <Tabs value={active} mb="lg">
        <Tabs.List>
          <Tabs.Tab value="edit" {...tabTarget(`${base}/edit`, disabled)}>
            Text Editor
          </Tabs.Tab>
          <Tabs.Tab value="annotate" {...tabTarget(`${base}/annotate`, disabled)}>
            Annotate
          </Tabs.Tab>
          <Tabs.Tab value="export" {...tabTarget(`${base}/export`, disabled)}>
            Export
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
    </>
  );
};
