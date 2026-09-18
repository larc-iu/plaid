import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '@ui/domain/permissions.js';
import { useLatestCall } from '@ui/hooks/useLatestCall.js';

// Shared loader + guard for manager-only project screens (General, Activity,
// Validation): fetch the project, expose a refetch for after saves, and bounce
// non-managers back to /projects once the project loads.
export const useManagedProject = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient, user } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // One route component serves every project id, so walking from A to B starts
  // a second read without ending the first and A can answer last. These screens
  // hand the loaded project's LAYER IDS to their Save, so a stale project
  // landing here writes A's settings onto A's layers while the reader is
  // reading B's.
  const begin = useLatestCall();

  // Keyed on projectId only: getClient's identity changes on every
  // AuthProvider render but always resolves the same client.
  const fetchProject = useCallback(async () => {
    const isCurrent = begin();
    try {
      setLoading(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const data = await client.projects.get(projectId);
      if (!isCurrent()) return null;
      setProject(data);
      return data;
    } catch (err) {
      if (!isCurrent()) return null;
      console.error('Failed to load project:', err);
      notifyError('Failed to load project.');
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, begin]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  // The project the ROUTE asks for. `project` still holds the one before it
  // while a second read is in flight, and keeps holding it when that read
  // fails, so both the guard below and the screens above read this instead:
  // otherwise a project the reader manages stands in for the one they are
  // looking at, and walking from a managed project to an unmanaged one is
  // briefly permitted.
  const loaded = project?.id === projectId ? project : null;
  const canConfigure = canManageProject(loaded, user);

  useEffect(() => {
    if (loaded && !canConfigure) navigate('/projects');
  }, [loaded, canConfigure, navigate]);

  return { projectId, project: loaded, loading, fetchProject, canConfigure };
};
