import { useState, useEffect, useCallback } from 'react';
import { useParams, useLocation, Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { useLatestCall } from '../../hooks/useLatestCall.js';
import { cn } from '../../lib/utils.js';

/**
 * A project's settings: a list of links down the left and the active section
 * beside it.
 *
 * Each section is route-backed, so a deep link keeps working and the active one
 * is read off the path. Only the active section is rendered, so each fetches
 * lazily. `sections` is the app's, as data: `{ value, label, body }`, where
 * `body({ projectId, project, reload })` is that section's screen. The first is
 * the default, and the one an unknown path redirects to.
 *
 * The section list is a list of LINKS rather than a tab widget: each section IS
 * a page with its own URL, so a link is what it is.
 */
export const ProjectSettingsShell = ({ tabs: Tabs, sections, href }) => {
  const { projectId } = useParams();
  const location = useLocation();
  const { getClient } = useAuth();
  const [project, setProject] = useState(null);

  const matched = sections.find((s) => location.pathname.endsWith(`/${s.value}`));
  const active = matched ?? sections[0];

  useDocumentTitle(active.label, project?.name);

  // The full project drives the tab strip (breadcrumb and permission gating);
  // the active section's child fetches whatever else it needs.
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
  if (!matched) return <Navigate to={href(projectId, sections[0].value)} replace />;

  return (
    <>
      <Tabs projectId={projectId} project={project} />

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Project Settings</h1>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row">
        <nav className="flex shrink-0 flex-col gap-1 sm:w-52">
          {sections.map(({ value, label }) => (
            <Link
              key={value}
              to={href(projectId, value)}
              aria-current={value === active.value ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                value === active.value
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {active.body({ projectId, project, reload: loadProject })}
        </div>
      </div>
    </>
  );
};
