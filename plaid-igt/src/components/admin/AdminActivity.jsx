import { useEffect, useState } from 'react';
import { ActivityPanel } from '@ui/components/shared/ActivityPanel';
import { documentTarget, projectTarget } from './projectTarget';

// The instance-wide half of the activity view. The roster it passes is the
// account directory, so "no changes in this window" names people who exist
// and have not worked, which the tally alone cannot say. The project list,
// read once, says where the feed's links lead.
export const AdminActivity = ({ client }) => {
  const [roster, setRoster] = useState([]);
  const [projectsById, setProjectsById] = useState(new Map());

  useEffect(() => {
    let alive = true;
    client.users
      .list()
      .then((all) => {
        if (alive) setRoster((all || []).filter((u) => !u.deactivatedAt));
      })
      .catch(() => {});
    client.projects
      .list()
      .then((all) => {
        if (alive) setProjectsById(new Map((all || []).map((p) => [p.id, p])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client]);

  return (
    <ActivityPanel
      client={client}
      roster={roster}
      projectHref={(project) => projectTarget(projectsById.get(project.id) ?? project)}
      documentHref={(document, project) =>
        documentTarget(document, projectsById.get(project.id) ?? project)
      }
    />
  );
};
