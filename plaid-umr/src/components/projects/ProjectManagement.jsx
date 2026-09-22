import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ProjectAccessScreen } from '@ui/components/shared/ProjectAccessScreen.jsx';
import { useAuth } from '../../contexts/AuthContext';
import { notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '@ui/domain/permissions.js';
import { useLatestCall } from '@ui/hooks/useLatestCall.js';
import { ROLE_OPTIONS } from '../../domain/roleGrants.js';

// The Users & Permissions section of Project Settings. The screen itself is the
// shared one (@ui/components/shared/ProjectAccessScreen), so the members table,
// the invitation links, the directory search and the account dialogs are the
// same in every app; what is here is the route: which project, who is asking,
// and whether they may be shown it at all.
export const ProjectManagement = () => {
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
      notifyError('Failed to load project data');
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  // Once per project. `fetchProject` is redefined every render, so naming it
  // here would refetch on every render.
  useEffect(() => {
    fetchProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;

  const denied = (message) => (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  );

  if (!project) return denied('Project not found');
  if (!canManageProject(project, user))
    return denied('You do not have permission to manage this project.');

  return (
    <ProjectAccessScreen
      project={project}
      projectId={projectId}
      client={getClient()}
      user={user}
      onDataUpdate={fetchProject}
      roleOptions={ROLE_OPTIONS}
    />
  );
};
