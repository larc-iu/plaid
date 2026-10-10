import { useEffect } from 'react';
import { useAuth } from '../../contexts/useAuth.js';
import { notifyError } from '../../lib/notify.js';
import { canManageProject } from '../../domain/permissions.js';
import { useProject } from '../../hooks/useProject.js';
import { Card, CardContent } from '../ui/card.jsx';
import { Loading } from './Loading.jsx';
import { Notice } from './Notice.jsx';
import { ProjectAccessScreen } from './ProjectAccessScreen.jsx';
import { ProjectAccessTokens } from './ProjectAccessTokens.jsx';

/**
 * The Access section of a project's settings, in every app: who may touch the
 * project (members, invitation links, adding a user) and the API tokens they
 * touch it with, two answers to one question.
 *
 * What is here is the route: which project, who is asking, and whether they may
 * be shown it at all. The screens are `ProjectAccessScreen` and
 * `ProjectAccessTokens`.
 *
 * Props, all the app's:
 * - `roleOptions`, what each role grants in the app's own words.
 * - `profileHref`, where a person manages their tokens.
 * - `onProjectUpdate`, told after a change here, for a page that holds the
 *   project too (a maintainer who steps down loses the Settings tab).
 */
export const ProjectAccessSettings = ({ roleOptions, profileHref, onProjectUpdate }) => {
  const { user, getClient } = useAuth();
  // A's member table and A's roles never stand under B's heading
  // (useProject keeps the newest read only).
  const { projectId, project, loading, error, reload } = useProject();

  useEffect(() => {
    if (error) notifyError('Failed to load the project');
  }, [error]);

  const changed = async () => {
    const data = await reload();
    onProjectUpdate?.();
    return data;
  };

  const denied = (message) => (
    <Notice tone="error" role="alert">
      {message}
    </Notice>
  );

  // Only the project the path names is shown (useProject). Until it is in
  // hand, Loading stands in. A re-read after a change keeps the screen mounted,
  // or the member table, a search being typed and an open dialog would all be
  // thrown away on every role change.
  if (!project) return loading ? <Loading /> : denied('Project not found');
  if (!canManageProject(project, user))
    return denied('You do not have permission to manage this project.');

  return (
    <>
      <Card>
        <CardContent className="pt-2">
          <ProjectAccessScreen
            project={project}
            projectId={projectId}
            client={getClient()}
            user={user}
            onDataUpdate={changed}
            roleOptions={roleOptions}
          />
        </CardContent>
      </Card>
      <ProjectAccessTokens profileHref={profileHref} />
    </>
  );
};
