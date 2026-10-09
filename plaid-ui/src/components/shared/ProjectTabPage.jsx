import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { statusOf } from '../../lib/errors.js';
import { LoadError } from './LoadError.jsx';
import { Loading } from './Loading.jsx';

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
// What the server answers for a project id that names nothing: 400 for one
// that is no id at all, 404 for one that is not there.
const NOT_FOUND = new Set([400, 404]);

export const ProjectTabPage = ({ title, tabs: Tabs, children }) => {
  const { projectId } = useParams();
  const { getClient } = useAuth();
  const client = getClient();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Bumped by Retry, which reads the project again.
  const [attempt, setAttempt] = useState(0);

  useDocumentTitle(title, project?.name);

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    setLoading(true);
    client.projects
      .get(projectId)
      .then((data) => {
        if (!alive) return;
        setProject(data);
        setFailed(false);
      })
      .catch((err) => {
        console.error('Failed to load project:', err);
        // A path naming no project (a mistyped link) is not worth a Retry.
        if (alive) setFailed(NOT_FOUND.has(statusOf(err)) ? 'missing' : true);
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
  }, [projectId, attempt]);

  let body = null;
  if (loading) body = <Loading />;
  else if (failed === 'missing' && !project) body = <LoadError>Project not found.</LoadError>;
  else if (failed && !project) {
    body = (
      <LoadError onRetry={() => setAttempt((n) => n + 1)}>Failed to load the project</LoadError>
    );
  } else if (project) body = children({ project, projectId, client });

  return (
    <div className="w-full">
      <Tabs projectId={projectId} project={project} />
      {body}
    </div>
  );
};
