import { useState, useEffect, useCallback } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ProjectCustomization } from './ProjectCustomization.jsx';
import { ProjectManagement } from './ProjectManagement.jsx';
import { ProjectAccessTokens } from './ProjectAccessTokens.jsx';
import { ProjectGeneral } from './ProjectGeneral.jsx';
import { ProjectServicesSettings } from './ProjectServicesSettings.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { cn } from '@ui/lib/utils';

// The five settings sections, in order, with the label each wears in the nav
// and in the browser title.
const SECTIONS = [
  ['management', 'Users & Permissions'],
  ['customization', 'UD Customization'],
  ['services', 'Services'],
  ['tokens', 'Access Tokens'],
  ['general', 'General'],
];

// Single settings view: user/permission management, UD customization
// (vocab/colors), services (registry + defaults), API access tokens, and
// general project settings (name, tokenizer locale, delete). Each section is
// route-backed (`/management`, `/customization`, `/services`, `/tokens`,
// `/general`) so deep links keep working; the active one is derived from the
// path. Only the active section mounts, so each child fetches lazily. The UD
// layer-structure setup form (ProjectConfiguration) is a separate standalone
// page at `/configuration`, used by the editor's "missing layers" auto-redirect.
//
// The section list is a plain list of links rather than a tab widget: each
// section IS a page with its own URL, so a link is what it is.
export const ProjectSettings = () => {
  const { projectId } = useParams();
  const location = useLocation();
  const { getClient } = useAuth();
  const [project, setProject] = useState(null);
  const active =
    SECTIONS.map(([value]) => value).find((value) => location.pathname.endsWith(`/${value}`)) ||
    'management';

  useDocumentTitle(Object.fromEntries(SECTIONS)[active], project?.name);

  // The full project drives ProjectTabs (breadcrumb + permission gating); the
  // active section's child fetches whatever else it needs.
  const loadProject = useCallback(() => {
    const client = getClient();
    if (!client) return;
    client.projects
      .get(projectId)
      .then((p) => setProject(p))
      .catch(() => {});
  }, [projectId, getClient]);

  useEffect(loadProject, [loadProject]);

  const body = {
    management: <ProjectManagement />,
    customization: <ProjectCustomization />,
    services: <ProjectServicesSettings />,
    tokens: <ProjectAccessTokens />,
    general: <ProjectGeneral onProjectUpdate={loadProject} />,
  }[active];

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      {/* The heading and the section list, with the body left to each
          section: the
          sections migrate one at a time, and a Mantine one inside the scoped
          preflight would have its own reset pulled out from under it. Each
          migrated section brings its own root. */}
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
