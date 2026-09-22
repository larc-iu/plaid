import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { notifyError } from '../../lib/notify.js';

/**
 * One project-level screen: the project read once, the app's tab strip above
 * it, and the screen's own body below.
 *
 * The strip is `tabs`, the app's own component, because which tabs a project
 * has is the app's. What is here is everything around it, and in particular
 * WHERE it sits: the row used to be wrapped in a different container on every
 * tab (`w-full`, `px-6 pt-4`, `max-w-6xl px-4 py-6`, `max-w-5xl px-4 py-6`), so
 * it jumped as the reader moved along it. There is one container now, the same
 * one the Documents tab always used, and a screen that wants a narrower body
 * constrains its own `children`.
 *
 * `children` is called with the loaded project, and is not rendered at all
 * until there is one.
 */
export const ProjectTabPage = ({ title, tabs: Tabs, children }) => {
  const { projectId } = useParams();
  const { getClient } = useAuth();
  const client = getClient();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  useDocumentTitle(title, project?.name);

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    setLoading(true);
    client.projects
      .get(projectId)
      .then((data) => {
        if (alive) setProject(data);
      })
      .catch((err) => {
        console.error('Failed to load project:', err);
        if (alive) notifyError('Failed to load project.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // getClient's identity changes on every AuthProvider render but always
    // resolves the same client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <div className="w-full">
      <Tabs projectId={projectId} project={project} />
      {loading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        project && children({ project, projectId, client })
      )}
    </div>
  );
};
