import { useEffect, useMemo, useState } from 'react';
import { ActivityPanel } from '@ui/components/shared/ActivityPanel';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useManagedProject } from './useManagedProject.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { ProjectTabs } from './ProjectTabs.jsx';

// Who has been working on this project, and on what. Maintainers only, like
// plaid-igt's tab of the same name, and the same component underneath: a UD
// project cannot be opened in plaid-igt (it sends a non-initialized project to
// its setup wizard), so this app needs its own way in.
//
// The roster is the project's own members, so "no changes in this window" names
// the people who were given access and have not used it.
export const ProjectActivity = () => {
  const { project, projectId, loading, canConfigure } = useManagedProject();
  const { getClient } = useAuth();
  const client = getClient();
  const [names, setNames] = useState({});

  useDocumentTitle('Activity', project?.name);

  const memberIds = useMemo(
    () =>
      [
        ...new Set([
          ...(project?.readers || []),
          ...(project?.writers || []),
          ...(project?.maintainers || []),
        ]),
      ].sort(),
    [project],
  );

  useEffect(() => {
    if (!client || memberIds.length === 0) return undefined;
    let alive = true;
    // One directory read rather than a lookup per member. This tab is
    // maintainer-only, which is exactly who the directory is open to.
    client.users
      .list()
      .then((all) => {
        if (!alive) return;
        setNames(Object.fromEntries((all || []).map((u) => [u.id, u.displayName || u.id])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, memberIds.length]);

  const roster = useMemo(
    () => memberIds.map((id) => ({ id, displayName: names[id] || id })),
    [memberIds, names],
  );

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!project || !canConfigure) return null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <ProjectTabs projectId={projectId} project={project} />
      <ActivityPanel
        client={client}
        projectId={projectId}
        roster={roster}
        // A document opens on its annotation grid here, not on a metadata tab.
        documentHref={(document) => `/projects/${projectId}/documents/${document.id}/annotate`}
        projectHref={() => `/projects/${projectId}/documents`}
      />
    </div>
  );
};
