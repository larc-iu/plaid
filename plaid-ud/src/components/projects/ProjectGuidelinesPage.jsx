import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { canEditProject } from '@ui/domain/permissions.js';
import { notifyError } from '../../utils/feedback.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { GuidelinesTab } from '@ui/components/guidelines/GuidelinesTab.jsx';

// The Guidelines tab: the project's own annotation manual, shared with
// plaid-igt (@ui/components/guidelines). Open to everyone who can open the
// project; writing is gated on canWrite inside the tab, and by the server.
export const ProjectGuidelinesPage = () => {
  const { projectId } = useParams();
  const { getClient, user } = useAuth();
  const client = getClient();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  useDocumentTitle('Guidelines', project?.name);

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
    <div className="w-full px-6 pt-4">
      <ProjectTabs projectId={projectId} project={project} />
      {loading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        project && (
          <GuidelinesTab
            client={client}
            projectId={projectId}
            canWrite={canEditProject(project, user)}
          />
        )
      )}
    </div>
  );
};
