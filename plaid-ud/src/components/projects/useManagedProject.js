import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '../../utils/permissions.js';

// Shared loader + guard for manager-only project settings tabs (UD
// Customization, General): fetch the project, expose a refetch for after
// saves, and bounce non-managers back to /projects once the project loads.
export const useManagedProject = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient, user } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // Keyed on projectId only: getClient's identity changes on every
  // AuthProvider render but always resolves the same client.
  const fetchProject = useCallback(async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const data = await client.projects.get(projectId);
      setProject(data);
      return data;
    } catch (err) {
      console.error('Failed to load project:', err);
      notifyError('Failed to load project.');
      return null;
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  const canConfigure = canManageProject(project, user);

  useEffect(() => {
    if (project && !canConfigure) navigate('/projects');
  }, [project, canConfigure, navigate]);

  return { projectId, project, loading, fetchProject, canConfigure };
};
