import { useState, useEffect, useCallback } from 'react';
import { useParams, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { useLatestCall } from '../../hooks/useLatestCall.js';
import { ProjectSettingsLayout } from './ProjectSettingsLayout.jsx';

const endsWith = (path, slug) => path.endsWith(`/${slug}`);

/**
 * A project's settings as a route of their own: the app's project tabs, then
 * the shared settings layout (`ProjectSettingsLayout`).
 *
 * Each section is route-backed, so a deep link keeps working and the active one
 * is read off the path. Only the active section is rendered, so each fetches
 * lazily. `sections` is the app's, as data: `{ value, label, body, aliases }`,
 * where `body({ projectId, project, reload })` is that section's screen and
 * `aliases` are the old path suffixes that now land on it (a section that was
 * folded into this one). The first is the default, and the one an unknown path
 * redirects to.
 */
export const ProjectSettingsShell = ({ tabs: Tabs, sections, href }) => {
  const { projectId } = useParams();
  const location = useLocation();
  const { getClient } = useAuth();
  const [project, setProject] = useState(null);

  const path = location.pathname;
  const matched = sections.find((s) => endsWith(path, s.value));
  const aliased = matched
    ? null
    : sections.find((s) => (s.aliases ?? []).some((a) => endsWith(path, a)));
  const active = matched ?? sections[0];

  // Walking from one project to another keeps this shell mounted, and the
  // project just left is still in state until the new one answers. A section
  // that writes takes ids off `project`, so it is handed only the one the path
  // names, and nothing while that one loads.
  const current = project?.id === projectId ? project : null;

  useDocumentTitle(active.label, current?.name);

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

  // Every hook above runs first, so these returns are unconditional as far as
  // React is concerned.
  if (!matched) {
    return <Navigate to={href(projectId, (aliased ?? sections[0]).value)} replace />;
  }

  return (
    <>
      <Tabs projectId={projectId} project={current} />
      <ProjectSettingsLayout
        sections={sections}
        active={active}
        href={(value) => href(projectId, value)}
        bodyProps={{ projectId, project: current, reload: loadProject }}
      />
    </>
  );
};
