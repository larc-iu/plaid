import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { canManageProject } from '../../utils/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { Tabs, TabsList, TabsTrigger } from '@ui/components/ui/tabs';

// Shared top tab bar for the four project-level views (Documents / Search /
// Project Settings / Import & Export), mirroring the per-document `DocumentTabs`.
// Each tab is route-backed; no panels are rendered — each route renders its own
// body. `project` is the full object every page already fetches (carries layer
// config for `getUdLayerInfo`); it may be null mid-load, which all the gating
// below tolerates.
export const ProjectTabs = ({ projectId, project }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const canManage = canManageProject(project, user);
  const configured = getUdLayerInfo(project).isConfigured;
  // Settings assumes a configured project; an unconfigured one routes to the
  // standalone layer-setup page instead (matches DocumentList's old behavior).
  const settingsTo = configured
    ? `/projects/${projectId}/management`
    : `/projects/${projectId}/configuration`;

  const p = location.pathname;
  const active = p.endsWith('/search')
    ? 'search'
    : p.endsWith('/import-export')
      ? 'import-export'
      : /\/(management|customization|services|tokens|general|configuration)$/.test(p)
        ? 'settings'
        : 'documents';

  const routes = {
    documents: `/projects/${projectId}/documents`,
    search: `/projects/${projectId}/search`,
    settings: settingsTo,
    'import-export': `/projects/${projectId}/import-export`,
  };

  return (
    <div className="mb-6">
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-2 text-sm">
        <Link to="/projects" className="text-muted-foreground hover:text-foreground">
          Projects
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="truncate text-muted-foreground">{project?.name || 'Loading…'}</span>
      </nav>

      {/* Every tab is a real anchor (`to`), so middle-click and cmd-click open
          it in a new browser tab; a plain click is Radix's, and this navigates
          on its behalf. The shared trigger already swallows Radix's double
          fire. */}
      <Tabs value={active} onValueChange={(v) => navigate(routes[v])}>
        <TabsList>
          <TabsTrigger value="documents" to={routes.documents}>
            Documents
          </TabsTrigger>
          <TabsTrigger value="search" to={routes.search}>
            Search
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="settings" to={routes.settings}>
              Project Settings
            </TabsTrigger>
          )}
          <TabsTrigger value="import-export" to={routes['import-export']}>
            Import &amp; Export
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
};
