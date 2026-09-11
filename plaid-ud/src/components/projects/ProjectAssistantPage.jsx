import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isReviewed } from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { canEditProject } from '../../utils/permissions.js';
import { notifyError } from '../../utils/feedback.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { ProjectAssistant } from '../assistant/ProjectAssistant.jsx';

// The Assistant tab: a chat with whatever `assist` service the operator runs
// (see ../../../../plaid-agent). Open to everyone who can open the project,
// since the assistant acts as the user and writes nothing they could not
// write themselves.
export const ProjectAssistantPage = () => {
  const { projectId } = useParams();
  const { getClient, user } = useAuth();
  const client = getClient();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  useDocumentTitle('Assistant', project?.name);

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
          <ProjectAssistant
            projectId={projectId}
            projectName={project.name}
            client={client}
            userId={user?.id}
            canWrite={canEditProject(project, user)}
            contributor={!!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin })}
          />
        )
      )}
    </div>
  );
};
