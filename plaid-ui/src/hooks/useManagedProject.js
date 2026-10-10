import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/useAuth.js';
import { canManageProject } from '../domain/permissions.js';
import { useProject } from './useProject.js';
import { notifyError } from '../lib/notify.js';
import { appRoutes } from '../lib/uiConfig.js';

// Loader and guard for the manager-only project screens (Activity, Validation,
// the settings sections): fetch the project, expose a refetch for after a save,
// and bounce anyone who may not manage it back to the project list, saying why
// (ruling umr-collab-validation-writers): a page met by URL that quietly turns
// into the project list reads as a broken link.
export const NOT_A_MAINTAINER = "Only a project's maintainers can open this page.";

// The toast itself, for a screen that guards a maintainers-only page of its
// own (igt's ProjectDetail). One toast however often an effect runs it
// (StrictMode runs effects twice).
export const notifyNotAMaintainer = () =>
  notifyError(NOT_A_MAINTAINER, undefined, { id: 'not-a-maintainer' });

export const useManagedProject = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  // These screens hand the loaded project's LAYER IDS to their Save, so a
  // stale project landing here would write A's settings onto A's layers while
  // the reader is reading B's: useProject gives only the route's project, as
  // its newest read has it. The guard below reads the same, so a project the
  // reader manages never stands in for the one they are looking at.
  const { projectId, project, loading, error, reload } = useProject();

  useEffect(() => {
    if (error) notifyError('Failed to load the project');
  }, [error]);

  const canConfigure = canManageProject(project, user);

  useEffect(() => {
    if (project && !canConfigure) {
      notifyNotAMaintainer();
      navigate(appRoutes().projects);
    }
  }, [project, canConfigure, navigate]);

  return { projectId, project, loading, fetchProject: reload, canConfigure };
};
