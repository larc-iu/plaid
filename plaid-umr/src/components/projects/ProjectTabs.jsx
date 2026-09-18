import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { canManageProject } from '@ui/domain/permissions.js';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { Tabs, TabsList, TabsTrigger } from '@ui/components/ui/tabs';

// The top tab bar for the project-level views, mirroring the per-document
// DocumentTabs. Each tab is route-backed and renders its own body. `project`
// may be null mid-load, which the gating tolerates.
export const ProjectTabs = ({ projectId, project }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const canManage = canManageProject(project, user);
  const configured = getUmrLayerInfo(project).isConfigured;
  // Settings assumes a configured project. An unconfigured one routes to the
  // layer-setup page instead.
  const settingsTo = configured
    ? `/projects/${projectId}/management`
    : `/projects/${projectId}/configuration`;

  const p = location.pathname;
  const active = p.endsWith('/guidelines')
    ? 'guidelines'
    : p.endsWith('/import-export')
      ? 'import-export'
      : p.endsWith('/activity')
        ? 'activity'
        : p.endsWith('/validate')
          ? 'validate'
          : /\/(management|customization|services|tokens|general|configuration)$/.test(p)
            ? 'settings'
            : 'documents';

  const routes = {
    documents: `/projects/${projectId}/documents`,
    guidelines: `/projects/${projectId}/guidelines`,
    activity: `/projects/${projectId}/activity`,
    validate: `/projects/${projectId}/validate`,
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
          it in a new browser tab. The shared trigger swallows Radix's double
          fire. */}
      <Tabs value={active} onValueChange={(v) => navigate(routes[v])}>
        <TabsList>
          <TabsTrigger value="documents" to={routes.documents}>
            Documents
          </TabsTrigger>
          <TabsTrigger value="guidelines" to={routes.guidelines}>
            Guidelines
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="validate" to={routes.validate}>
              Validation
            </TabsTrigger>
          )}
          {canManage && (
            <TabsTrigger value="activity" to={routes.activity}>
              Activity
            </TabsTrigger>
          )}
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
