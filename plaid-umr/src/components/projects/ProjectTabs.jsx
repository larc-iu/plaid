import { Link, useLocation, useNavigate } from 'react-router-dom';
import { isReviewed } from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { Tabs, TabsList, TabsTrigger } from '@ui/components/ui/tabs';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { useAssistantSubject } from '@ui/components/assistant/subject.js';
import { UMR_ASSISTANT } from '../assistant/adapter.js';

// The top tab bar for the project-level views, mirroring the per-document
// DocumentTabs. Each tab is route-backed and renders its own body. `project`
// may be null mid-load, which the gating tolerates.
//
// It is also where the shell's assistant panel learns which project the reader
// is on. Every project-level screen renders this strip and is already handed
// the project, so this is the ONE place that fact exists for all of them. A
// document has a subject of its own (see DocumentEditorShell) and does not
// render this.
export const ProjectTabs = ({ projectId, project }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, getClient } = useAuth();
  // The tab is offered only when an assistant is online. The ROUTE still
  // works, so a link to a past conversation opens whether or not one is
  // running: this hides the invitation, not the conversations.
  const assistantAvailable = useAssistantAvailable(getClient(), projectId, UMR_ASSISTANT.app);

  // The panel is about the PROJECT here. No subject of its own: what a reader
  // is looking at on these screens is the project at large, and naming a screen
  // the assistant has no tool for (the importer, the access list) would invite
  // it to claim it can act there.
  useAssistantSubject({
    projectId,
    projectName: project?.name,
    canWrite: canEditProject(project, user),
    contributor: !!project && !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }),
  });

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
    : p.endsWith('/assistant')
      ? 'assistant'
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
    assistant: `/projects/${projectId}/assistant`,
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
          {(assistantAvailable || active === 'assistant') && (
            <TabsTrigger value="assistant" to={routes.assistant}>
              Assistant
            </TabsTrigger>
          )}
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
