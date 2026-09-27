import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { notifyError } from '../../lib/notify.js';
import { canManageProject } from '../../domain/permissions.js';
import { useLatestCall } from '../../hooks/useLatestCall.js';
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
  const { projectId } = useParams();
  const { user, getClient } = useAuth();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // One route component serves every project id, so walking from A to B starts
  // a second read without ending the first and A can answer last, putting A's
  // member table and A's roles under B's heading.
  const begin = useLatestCall();

  const fetchProject = async () => {
    const isCurrent = begin();
    try {
      setLoading(true);
      const data = await getClient().projects.get(projectId);
      if (!isCurrent()) return null;
      setProject(data);
      return data;
    } catch (err) {
      if (!isCurrent()) return null;
      console.error('Error fetching project:', err);
      setProject(null);
      notifyError('Failed to load project data');
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  const changed = async () => {
    const data = await fetchProject();
    onProjectUpdate?.();
    return data;
  };

  // Once per project. `fetchProject` is redefined every render, so naming it
  // here would refetch on every render.
  useEffect(() => {
    fetchProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const denied = (message) => (
    <Notice tone="error" role="alert">
      {message}
    </Notice>
  );

  // Only the project the path names is shown. Until it is in hand, Loading
  // stands in, and a project the reader left is never drawn under the next
  // one's id. A re-read after a change keeps the screen mounted, or the member
  // table, a search being typed and an open dialog would all be thrown away on
  // every role change.
  const current = project?.id === projectId ? project : null;
  if (!current) return project === null && !loading ? denied('Project not found') : <Loading />;
  if (!canManageProject(current, user))
    return denied('You do not have permission to manage this project.');

  return (
    <>
      <Card>
        <CardContent className="pt-2">
          <ProjectAccessScreen
            project={current}
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
