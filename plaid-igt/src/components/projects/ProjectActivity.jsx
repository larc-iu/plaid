import { ActivityPanel } from '@ui/components/shared/ActivityPanel';
import { useProjectRoster } from '@ui/hooks/useProjectRoster.js';

// The project-scoped half of the activity view. Its roster is the project's
// own members, so "no changes in this window" names the people who were given
// access and have not used it.
export const ProjectActivity = ({ client, project, projectId }) => {
  const roster = useProjectRoster(client, project);
  return <ActivityPanel client={client} projectId={projectId} roster={roster} />;
};
