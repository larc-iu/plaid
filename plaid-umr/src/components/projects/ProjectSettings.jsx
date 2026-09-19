import { useState, useEffect, useCallback } from 'react';
import { useParams, useLocation, Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ProjectManagement } from './ProjectManagement.jsx';
import { ProjectAccessTokens } from '@ui/components/shared/ProjectAccessTokens.jsx';
import { ProjectGeneralSettings } from './ProjectGeneralSettings.jsx';
import { UmrSettings } from './UmrSettings.jsx';
import { ProjectServicesSettings } from './ProjectServicesSettings.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { useLatestCall } from '@ui/hooks/useLatestCall.js';
import { cn } from '@ui/lib/utils';

// The settings sections, in order, with the label each wears in the nav and in
// the browser title.
const SECTIONS = [
  ['management', 'Users & Permissions'],
  ['customization', 'UMR settings'],
  ['services', 'Services'],
  ['tokens', 'Access Tokens'],
  ['general', 'General'],
];

// Single settings view: user/permission management, the UMR settings, the
// service each integration spot uses, API access tokens, and general project
// settings (name, language, text direction, delete). Each section is
// route-backed (`/management`, `/customization`, `/services`, `/tokens`,
// `/general`) so deep links keep working; the active one is derived from the
// path. Only the active section mounts, so each child fetches lazily. The
// layer setup form (ProjectConfiguration) is a separate standalone page at
// `/configuration`, used by the document list's missing-layers redirect.
//
// The section list is a plain list of links rather than a tab widget: each
// section IS a page with its own URL, so a link is what it is.
export const ProjectSettings = () => {
  const { projectId } = useParams();
  const location = useLocation();
  const { getClient } = useAuth();
  const [project, setProject] = useState(null);
  const matched = SECTIONS.map(([value]) => value).find((value) =>
    location.pathname.endsWith(`/${value}`),
  );
  const active = matched || 'management';

  useDocumentTitle(Object.fromEntries(SECTIONS)[active], project?.name);

  // The full project drives ProjectTabs (breadcrumb + permission gating); the
  // active section's child fetches whatever else it needs.
  const begin = useLatestCall();
  const loadProject = useCallback(() => {
    const client = getClient();
    if (!client) return;
    // One settings shell across projects: the project just left can answer last.
    const isCurrent = begin();
    client.projects
      .get(projectId)
      .then((p) => isCurrent() && setProject(p))
      .catch(() => {});
  }, [projectId, getClient, begin]);

  useEffect(loadProject, [loadProject]);

  // Every hook above runs first, so this return is unconditional as far as
  // React is concerned.
  if (!matched) return <Navigate to={`/projects/${projectId}/management`} replace />;

  const body = {
    management: <ProjectManagement />,
    customization: <UmrSettings />,
    services: <ProjectServicesSettings />,
    tokens: <ProjectAccessTokens profileHref="/profile" />,
    general: <ProjectGeneralSettings onProjectUpdate={loadProject} />,
  }[active];

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Project Settings</h1>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row">
        <nav className="flex shrink-0 flex-col gap-1 sm:w-52">
          {SECTIONS.map(([value, label]) => (
            <Link
              key={value}
              to={`/projects/${projectId}/${value}`}
              aria-current={value === active ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                value === active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="min-w-0 flex-1">{body}</div>
      </div>
    </>
  );
};
