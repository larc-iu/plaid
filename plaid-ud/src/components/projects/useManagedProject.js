import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '@ui/domain/permissions.js';
import { useLatestCall } from '@ui/hooks/useLatestCall.js';

// Shared loader + guard for manager-only project settings tabs (UD
// Customization, General): fetch the project, expose a refetch for after
// saves, and bounce non-managers back to /projects once the project loads.
export const useManagedProject = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient, user } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // One route component serves every project id, so walking from A to B starts
  // a second read without ending the first and A can answer last. These tabs
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

  const canConfigure = canManageProject(project, user);

  useEffect(() => {
    if (project && !canConfigure) navigate('/projects');
  }, [project, canConfigure, navigate]);

  return { projectId, project, loading, fetchProject, canConfigure };
};
