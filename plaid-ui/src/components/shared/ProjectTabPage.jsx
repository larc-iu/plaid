import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { useProject } from '../../hooks/useProject.js';
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
 * `children` is called with `{ project, projectId, client, documents, reload }`
 * once the project is loaded, and the body is not rendered at all until then.
 * `withDocuments` reads the project's document listing beside it, as
 * `documents`. `reload({ quiet })` reads both again (useProject), for a screen
 * that changed the project. One page serves every project id and every tab
 * whose address keeps the same route (plaid-igt's `?tab=`), so the project is
 * read once for all of them, and a project the reader left never stands under
 * the next one's tabs. A read refused as signed out signs the reader out.
 */
// What the server answers for a project id that names nothing: 400 for one
// that is no id at all, 404 for one that is not there.
const NOT_FOUND = new Set([400, 404]);

export const ProjectTabPage = ({ title, tabs: Tabs, withDocuments = false, children }) => {
  const { getClient } = useAuth();
  const client = getClient();
  const { projectId, project, documents, loading, error, reload } = useProject({
    withDocuments,
    logoutOnAuthError: true,
  });

  useDocumentTitle(title, project?.name);

  let body = null;
  if (loading) body = <Loading />;
  else if (project) body = children({ project, projectId, client, documents, reload });
  else if (error && NOT_FOUND.has(statusOf(error)))
    body = <LoadError>Project not found.</LoadError>;
  else if (error) {
    body = <LoadError onRetry={() => reload()}>Failed to load the project</LoadError>;
  }

  return (
    <div className="w-full">
      <Tabs projectId={projectId} project={project} />
      {body}
    </div>
  );
};
