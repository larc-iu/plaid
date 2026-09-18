import { ActivityPanel } from '@ui/components/shared/ActivityPanel';
import { useProjectRoster } from '@ui/hooks/useProjectRoster.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useManagedProject } from './useManagedProject.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { ProjectTabs } from './ProjectTabs.jsx';

// Who has been working on this project, and on what. Maintainers only, and the
// same component plaid-igt and plaid-ud mount under their tab of the same name.
//
// The roster is the project's own members, so "no changes in this window" names
// the people who were given access and have not used it.
export const ProjectActivity = () => {
  const { project, projectId, loading, canConfigure } = useManagedProject();
  const { getClient } = useAuth();
  const client = getClient();
  const roster = useProjectRoster(client, project);

  useDocumentTitle('Activity', project?.name);

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!project || !canConfigure) return null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <ProjectTabs projectId={projectId} project={project} />
      <ActivityPanel
        client={client}
        projectId={projectId}
        roster={roster}
        // A document opens on its annotation page here, not on a metadata tab.
        documentHref={(document) => `/projects/${projectId}/documents/${document.id}/annotate`}
        projectHref={() => `/projects/${projectId}/documents`}
      />
    </div>
  );
};
