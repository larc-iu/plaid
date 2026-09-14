import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { Activity, FileText, Search, Replace, ShieldCheck, Download, Settings } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@ui/components/ui/tabs';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentList } from './DocumentList';
import { ProjectSearch } from './search/ProjectSearch.jsx';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { Suspended } from '@ui/components/shared/Suspended';
import { lazyNamed } from '@ui/lib/lazyNamed';

// The tabs a visit rarely opens ride in their own chunks: Bulk Edit,
// Validation, Activity, the Assistant (and its markdown), and Export (and the
// format writers). Documents, Search, and Settings load with the page.
const ProjectBulkEdit = lazyNamed(() => import('./bulk/ProjectBulkEdit.jsx'), 'ProjectBulkEdit');
const ProjectValidation = lazyNamed(
  () => import('./validate/ProjectValidation.jsx'),
  'ProjectValidation',
);
const ProjectAssistant = lazyNamed(
  () => import('./assistant/ProjectAssistant.jsx'),
  'ProjectAssistant',
);
const ProjectActivity = lazyNamed(() => import('./ProjectActivity.jsx'), 'ProjectActivity');
const ProjectExport = lazyNamed(() => import('./ProjectExport.jsx'), 'ProjectExport');
import { readInitialized, readImportState, importRouteFor } from '@/domain/igtConfig';
import { isReviewed } from '@larc-iu/plaid-client';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { useTabParam } from '@/hooks/useTabParam';
import { contentTabsFor, TAB_ALIASES } from '@/domain/projectTabs';
import { cn } from '@ui/lib/utils';
import { useComposeProject } from '@/hooks/useCompose';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { useAssistantSubject } from '@ui/components/assistant/subject.js';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { IGT_ASSISTANT } from './assistant/adapter.js';

// The settings sections live behind these path suffixes; keeping them in the
// URL means deep links and the back button still land on the right section.
const SETTINGS_SECTIONS = ['general', 'text-and-vocab', 'annotation', 'access', 'services'];

// Title-bar labels for the settings sections (match ProjectSettingsPanel).
const SECTION_TITLES = {
  general: 'General',
  'text-and-vocab': 'Text and Vocab',
  annotation: 'Annotation',
  access: 'Access',
  services: 'Services',
};

// Default project view: the document list, a query-engine-powered Search tab,
// and (for maintainers) a Bulk Edit workbench and a Settings tab. Settings is a real panel in this tab
// group — selecting it stays on the page and renders project administration as
// a left-side vertical tab group (ProjectSettingsPanel), route-backed by the
// /access, /tokens, /services, /export, /settings suffixes.

export const ProjectDetail = () => {
  const { projectId, presetId = null } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, client, logout } = useAuth();
  const [project, setProject] = useState(null);
  // The rows and the project they belong to, together: walking from A to B
  // renders once with B's id and A's state before any effect runs, and a list
  // of A's documents under B's name is a list the reader can click.
  const [docs, setDocs] = useState({ projectId, rows: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Settings edits change the PROJECT (its config and layers) and never the
  // document list, so they refresh only that. Reordering one annotation field
  // used to re-list every document in the project.
  // A code bound under Settings applies everywhere this project is open.
  useComposeProject(project);

  // Walking from project A to project B keeps this component mounted and
  // starts a second load without ending the first. Nothing orders them, so A
  // can answer last and every screen below would then be reading A under B's
  // heading. Settings makes that worse than a wrong title: it takes LAYER IDS
  // off the loaded project, so a stale one sends A's layers into a Save the
  // reader makes on B. One token per project id, cancelled by the effect's
  // cleanup, and both writers of `project` check it.
  const live = useRef(null);

  const refreshProject = async () => {
    if (!client) return;
    const token = live.current;
    try {
      const projectData = await client.projects.get(projectId);
      if (token?.cancelled) return;
      setProject(projectData);
    } catch (err) {
      console.error('Could not refresh the project:', err);
    }
  };

  const fetchData = async (token) => {
    try {
      setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const [projectData, docsList] = await Promise.all([
        client.projects.get(projectId),
        client.projects.listDocuments(projectId),
      ]);
      if (token.cancelled) return;
      setProject(projectData);
      setDocs({ projectId, rows: docsList || [] });
      setError('');
    } catch (err) {
      if (token.cancelled) return;
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Clear the rejected token before leaving, else /login bounces back.
        logout('expired');
        return;
      }
      setError('Failed to load data');
      console.error('Error fetching data:', err);
    } finally {
      if (!token.cancelled) setLoading(false);
    }
  };

  useEffect(() => {
    const token = { cancelled: false };
    live.current = token;
    fetchData(token);
    return () => {
      token.cancelled = true;
    };
    // Runs once per id; the loader reads the client fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const canManage = canManageProject(project, user);
  // Creating/editing documents needs WRITE, which writers have but managing
  // (settings/access) does not. Gate document-create on this so a reader isn't
  // shown a button that 403s on submit.
  const canWrite = canEditProject(project, user);

  // Which top-level tab is active. Documents/Search are local UI state; the
  // Settings tab is reflected in the path so its sections are deep-linkable.
  // The section is the path segment after the project id; a section may carry
  // a sub-path (e.g. /export/:presetId opens one preset's editor in place).
  const pathSection =
    SETTINGS_SECTIONS.find((s) => location.pathname.startsWith(`/projects/${projectId}/${s}`)) ||
    null;
  const onSettings = pathSection !== null;
  // Export is path-backed like Settings, because a preset's editor is a page of
  // its own at /projects/:id/export/:presetId. Unlike Settings it is open to
  // readers, who can run an export without being able to change the presets.
  const onExport = location.pathname.startsWith(`/projects/${projectId}/export`);

  // Tab title: "<Section> · <Project> · Plaid IGT" on a settings section, else
  // "<Project> · Plaid IGT". Both segments are dropped while still loading.
  useDocumentTitle(
    onExport ? 'Export' : onSettings ? SECTION_TITLES[pathSection] : null,
    project?.name,
  );
  // Documents/Search live in `?tab=`, so a reload or a shared link reopens the
  // tab the user was on.
  // `ready` while the project is still loading would correct a good link:
  // `canManage` answers false until it lands, so the list can still grow.
  const contentTabs = useMemo(() => contentTabsFor(canManage), [canManage]);
  const [contentTab, setContentTab, tabHref] = useTabParam(contentTabs, 'documents', {
    aliases: TAB_ALIASES,
    ready: !!project,
  });
  const assistantAvailable = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  // The shell's panel is about this PROJECT while the reader is on any of its
  // screens. No subject of its own: what a reader is looking at here is the
  // project at large, and naming a screen the assistant has no tool for (the
  // export wizard, the access list) would invite it to claim it can act there.
  useAssistantSubject({
    projectId,
    projectName: project?.name,
    canWrite,
    contributor: !!project && !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }),
  });
  const activeTab = onExport ? 'export' : onSettings && canManage ? 'settings' : contentTab;

  // A non-maintainer who lands on a settings URL has nothing to manage; bounce
  // them back to the document view rather than show an empty Settings panel.
  useEffect(() => {
    if (onSettings && project && !canManage) {
      navigate(`/projects/${projectId}`, { replace: true });
    }
  }, [onSettings, project, canManage, projectId, navigate]);

  // A project not yet set up for IGT: maintainers go to the setup/adopt wizard;
  // non-maintainers can't create layers, so they get an informational notice
  // (rendered below) rather than a dead-end redirect into a wizard they can't
  // complete.
  useEffect(() => {
    if (project && !readInitialized(project.config) && canManage) {
      navigate(`/projects/${projectId}/setup`, { replace: true });
    }
  }, [project, projectId, navigate, canManage]);

  const needsSetupNotice = !!project && !readInitialized(project.config) && !canManage;
  // An import that never reported finishing: the project is half filled, and
  // the resume DELETES the documents it did not complete, so there is nothing
  // safe to do here until it is over. A maintainer is sent back to the wizard
  // to finish it (or to declare it finished as it stands); anyone else gets
  // the notice below, since they cannot run an import.
  const unfinishedImport = project ? readImportState(project.config) : null;
  const importResumeTo = unfinishedImport && importRouteFor(unfinishedImport.kind);
  useEffect(() => {
    if (importResumeTo && canManage) {
      navigate(`${importResumeTo}?resume=${projectId}`, { replace: true });
    }
  }, [importResumeTo, canManage, projectId, navigate]);

  const handleDocumentCreated = (newDocument) => {
    setDocs((prev) => ({ ...prev, rows: [...prev.rows, newDocument] }));
  };

  // Nothing of another project's, ever: the rows are the route's or there are
  // none yet.
  const documents = docs.projectId === projectId ? docs.rows : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error || 'The requested project could not be found.'}
        </div>
      </div>
    );
  }

  if (unfinishedImport && !(canManage && importResumeTo)) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
        <div
          role="status"
          className="mt-4 rounded-md border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          The {unfinishedImport.kind} import
          {unfinishedImport.source ? ` of “${unfinishedImport.source}”` : ''} did not finish.
          {canManage ? ' Continuing it…' : ' Ask a project maintainer to finish it.'}
        </div>
      </div>
    );
  }

  if (needsSetupNotice) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
        <div
          role="status"
          className="mt-4 rounded-md border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          This project hasn’t been set up for IGT yet. Ask a project maintainer to add IGT support.
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mx-auto px-4 py-8',
        // The assistant is a two-pane chat and wants the room.
        activeTab === 'assistant' ? 'max-w-7xl' : 'max-w-5xl',
      )}
    >
      <div>
        <nav className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground">
            Projects
          </Link>
          <span>/</span>
          <span className="text-foreground">{project.name}</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (v === 'settings') {
            // Enter Settings via its default section; the path drives the panel.
            navigate(`/projects/${projectId}/general`);
          } else if (v === 'export') {
            navigate(`/projects/${projectId}/export`);
          } else if (onSettings || onExport) {
            // Leaving Settings means dropping the section suffix from the URL.
            // Path and query move together in one navigation, since a separate
            // query update would race with this one.
            navigate(tabHref(`/projects/${projectId}`, v));
          } else {
            setContentTab(v);
          }
        }}
      >
        <TabsList className="mb-2">
          <TabsTrigger value="documents" to={tabHref(`/projects/${projectId}`, 'documents')}>
            <FileText className="h-4 w-4" /> Documents
          </TabsTrigger>
          <TabsTrigger value="search" to={tabHref(`/projects/${projectId}`, 'search')}>
            <Search className="h-4 w-4" /> Search
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="bulk" to={tabHref(`/projects/${projectId}`, 'bulk')}>
              <Replace className="h-4 w-4" /> Bulk Edit
            </TabsTrigger>
          )}
          {canManage && (
            <TabsTrigger value="validate" to={tabHref(`/projects/${projectId}`, 'validate')}>
              <ShieldCheck className="h-4 w-4" /> Validation
            </TabsTrigger>
          )}
          {canManage && (
            <TabsTrigger value="activity" to={tabHref(`/projects/${projectId}`, 'activity')}>
              <Activity className="h-4 w-4" /> Activity
            </TabsTrigger>
          )}
          {/* Offered only when an assistant is online. The tab itself still
              renders when it is the active one, so a link to a past
              conversation opens whether or not one is running: this hides the
              invitation, not the conversations. */}
          {(assistantAvailable || activeTab === 'assistant') && (
            <TabsTrigger value="assistant" to={tabHref(`/projects/${projectId}`, 'assistant')}>
              <AssistantMark className="h-4 w-4" /> Assistant
            </TabsTrigger>
          )}
          <TabsTrigger value="export" to={`/projects/${projectId}/export`}>
            <Download className="h-4 w-4" /> Export
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="settings" to={`/projects/${projectId}/general`}>
              <Settings className="h-4 w-4" /> Settings
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="documents">
          <DocumentList
            documents={documents}
            project={project}
            projectId={projectId}
            client={client}
            canManage={canManage}
            canWrite={canWrite}
            onDocumentCreated={handleDocumentCreated}
          />
        </TabsContent>
        <TabsContent value="search">
          <ProjectSearch project={project} projectId={projectId} client={client} />
        </TabsContent>
        {canManage && (
          <TabsContent value="bulk">
            <Suspended>
              <ProjectBulkEdit project={project} projectId={projectId} client={client} />
            </Suspended>
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="validate">
            <Suspended>
              <ProjectValidation
                project={project}
                projectId={projectId}
                client={client}
                onProjectUpdate={refreshProject}
              />
            </Suspended>
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="activity">
            <div>
              <Suspended>
                <ProjectActivity client={client} project={project} projectId={projectId} />
              </Suspended>
            </div>
          </TabsContent>
        )}
        <TabsContent value="assistant">
          <Suspended>
            <ProjectAssistant
              projectId={projectId}
              projectName={project?.name}
              client={client}
              userId={user?.id}
              canWrite={canWrite}
              contributor={
                !!project && !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin })
              }
            />
          </Suspended>
        </TabsContent>
        <TabsContent value="export">
          <Suspended>
            <ProjectExport
              project={project}
              projectId={projectId}
              client={client}
              documents={documents}
              canManage={canManage}
              presetId={presetId}
              onProjectUpdate={refreshProject}
            />
          </Suspended>
        </TabsContent>
        {canManage && (
          <TabsContent value="settings">
            <ProjectSettingsPanel
              project={project}
              projectId={projectId}
              client={client}
              user={user}
              section={pathSection || 'general'}
              onSectionChange={(s) => navigate(`/projects/${projectId}/${s}`)}
              onProjectUpdate={refreshProject}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
};
