import { useAuth } from '../../contexts/useAuth.js';
import { useProjectRoster } from '../../hooks/useProjectRoster.js';
import { useManagedProject } from '../../hooks/useManagedProject.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { ActivityPanel } from './ActivityPanel.jsx';

// Who has been working on this project, and on what. Maintainers only.
//
// The roster is the project's own members, so "no changes in this window" names
// the people who were given access and have not used it. `tabs` is the app's
// project tab strip; a document opens on its work surface, not on a metadata
// tab, and which route that is the app says through `appRoutes`.
export const ProjectActivityPage = ({ tabs: Tabs }) => {
  const { project, projectId, loading, canConfigure } = useManagedProject();
  const { getClient } = useAuth();
  const client = getClient();
  const roster = useProjectRoster(client, project);

  useDocumentTitle('Activity', project?.name);

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!project || !canConfigure) return null;

  const routes = appRoutes();

  return (
    <div className="w-full">
      <Tabs projectId={projectId} project={project} />
      <div className="mx-auto w-full max-w-6xl">
        <ActivityPanel
          client={client}
          projectId={projectId}
          roster={roster}
          documentHref={(document) => routes.document(projectId, document.id)}
          projectHref={() => routes.documents(projectId)}
        />
      </div>
    </div>
  );
};
