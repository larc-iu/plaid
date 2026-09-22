import { isReviewed } from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/useAuth.js';
import { canEditProject } from '../../domain/permissions.js';
import { AssistantTab } from '../assistant/AssistantTab.jsx';
import { ProjectTabPage } from './ProjectTabPage.jsx';

// The Assistant tab: a chat with whatever `assist` service the operator runs
// (see plaid-agent). Open to everyone who can open the project, since the
// assistant acts as the user and writes nothing they could not write
// themselves. `adapter` is the app's half of the assistant: how a place in a
// document is addressed and linked, and how a cited sentence is drawn.
export const ProjectAssistantPage = ({ tabs, adapter }) => {
  const { user } = useAuth();
  return (
    <ProjectTabPage title="Assistant" tabs={tabs}>
      {({ project, projectId, client }) => (
        <AssistantTab
          adapter={adapter}
          projectId={projectId}
          projectName={project.name}
          client={client}
          userId={user?.id}
          canWrite={canEditProject(project, user)}
          contributor={!!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin })}
        />
      )}
    </ProjectTabPage>
  );
};
