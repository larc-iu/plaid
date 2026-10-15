import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { canManageProject } from '@ui/domain/permissions.js';
import { notifyNotAMaintainer } from '@ui/hooks/useManagedProject.js';

// The guard for a project screen only its maintainers may use (the setup
// wizard, Add ELAN documents), met by address. Anyone else goes to the project
// itself, told why, as the settings sections send them (ProjectDetail).
// Answers true once `project` is loaded and the user may manage it, false once
// it is loaded and they may not, and null while it loads, so the screen can
// hold its wizard back until it knows.
export const useMaintainersOnly = (projectId, project) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const allowed = project ? canManageProject(project, user) : null;
  useEffect(() => {
    if (allowed !== false) return;
    notifyNotAMaintainer();
    navigate(`/projects/${projectId}`, { replace: true });
  }, [allowed, projectId, navigate]);
  return allowed;
};
