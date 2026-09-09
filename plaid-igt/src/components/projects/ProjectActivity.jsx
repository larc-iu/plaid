import { useEffect, useMemo, useState } from 'react';
import { ActivityPanel } from '../admin/ActivityPanel';

// The project-scoped half of the activity view. Its roster is the project's
// own members, so "no changes in this window" names the people who were given
// access and have not used it, which is the question an instructor asks.
export const ProjectActivity = ({ client, project, projectId }) => {
  const [names, setNames] = useState({});

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
    if (memberIds.length === 0) return undefined;
    let alive = true;
    // One directory read rather than a lookup per member. This tab is
    // maintainer-only, which is exactly who the directory is open to.
    client.users
      .listPage({ limit: 1000 })
      .then((page) => {
        if (!alive) return;
        setNames(
          Object.fromEntries((page.entries || []).map((u) => [u.id, u.displayName || u.id])),
        );
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

  return <ActivityPanel client={client} projectId={projectId} roster={roster} />;
};
