import { useAuth } from '../../contexts/useAuth.js';
import { canEditProject } from '../../domain/permissions.js';
import { GuidelinesTab } from '../guidelines/GuidelinesTab.jsx';
import { ProjectTabPage } from './ProjectTabPage.jsx';
import { SectionHeader } from './SectionHeader.jsx';

// The Guidelines tab: the project's own annotation manual. Open to everyone who
// can open the project; writing is gated on canWrite inside the tab, and by the
// server. `tabs` is the app's project tab strip.
export const ProjectGuidelinesPage = ({ tabs }) => {
  const { user } = useAuth();
  return (
    <ProjectTabPage title="Guidelines" tabs={tabs}>
      {({ project, projectId, client }) => (
        <>
          <SectionHeader title="Guidelines" />
          <GuidelinesTab
            client={client}
            projectId={projectId}
            project={project}
            canWrite={canEditProject(project, user)}
          />
        </>
      )}
    </ProjectTabPage>
  );
};
