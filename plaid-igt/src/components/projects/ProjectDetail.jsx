import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentList } from './DocumentList';
import { ProjectSearch } from './search/ProjectSearch.jsx';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { Suspended } from '@ui/components/shared/Suspended';
import { ProjectTabStrip } from '@ui/components/shared/ProjectTabStrip.jsx';
import { Breadcrumb } from '@ui/components/shared/Breadcrumb.jsx';
import { ProjectTartan } from '@ui/components/shared/ProjectTartan.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { LoadError } from '@ui/components/shared/LoadError.jsx';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
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
const GuidelinesTab = lazyNamed(
  () => import('@ui/components/guidelines/GuidelinesTab.jsx'),
  'GuidelinesTab',
);
const ProjectExport = lazyNamed(() => import('./ProjectExport.jsx'), 'ProjectExport');
import { readInitialized, readImportState, importRouteFor } from '@/domain/igtConfig';
import { isReviewed } from '@larc-iu/plaid-client';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { useLatestCall } from '@ui/hooks/useLatestCall.js';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { useTabParam } from '@/hooks/useTabParam';
import { contentTabsFor, isMaintainerTab, TAB_ALIASES } from '@/domain/projectTabs';
import { notifyNotAMaintainer } from '@ui/hooks/useManagedProject.js';
import { useComposeProject } from '@/hooks/useCompose';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { IGT_ASSISTANT } from './assistant/adapter.js';

// The settings sections live behind these path suffixes; keeping them in the
// URL means deep links and the back button still land on the right section.
const SETTINGS_SECTIONS = ['general', 'text-and-vocab', 'annotation', 'access', 'services'];

// Title-bar labels for the settings sections (match ProjectSettingsPanel).
const SECTION_TITLES = {
  general: 'General',
  'text-and-vocab': 'Text and vocab',
  annotation: 'Annotation',
  access: 'Access',
  services: 'Services',
};

// Default project view, under the shared project tab strip: the document list,
// a query-engine-powered Search tab, and (for maintainers) a Bulk Edit
// workbench and a Settings tab. The content tabs ride in `?tab=`, so the strip
// is told which is active. Export and Settings are path-backed: Settings
// renders project administration in the shared settings layout
// (ProjectSettingsPanel), one section per path suffix.

export const ProjectDetail = () => {
  const { projectId, presetId = null } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, client, logout } = useAuth();
  const [loaded, setProject] = useState(null);
  // Only the project the path names. The same frame that carries B's id still
  // holds A until B's read lands, and every tab below takes ids off `project`
  // (Settings takes layer ids), so until then there is none.
  const project = loaded?.id === projectId ? loaded : null;
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

  // A settings page reads the project again after each save, and waits for it
  // before it lets the next save go, since the next save expects what that
  // read says. Two reads can be out at once (two saves, or two pages), and a
  // read that started first can answer last. Only the newest read is shown,
  // or a page would expect a value from before its own last save and be
  // refused as changed elsewhere. A superseded call waits for the newest one,
  // so whoever awaits it sees the project as it stands.
  const begin = useLatestCall();
  const newestRefresh = useRef(null);
  const refreshProject = () => {
    if (!client) return Promise.resolve();
    const token = live.current;
    const isCurrent = begin();
    const done = (async () => {
      try {
        const projectData = await client.projects.get(projectId);
        if (token?.cancelled || !isCurrent()) return;
        setProject(projectData);
      } catch (err) {
        if (isCurrent()) console.error('Could not refresh the project:', err);
      }
    })().then(() => {
      // Unmounting also ends a call, with no newer one to wait for.
      const newest = newestRefresh.current;
      return isCurrent() || newest === done ? undefined : newest;
    });
    newestRefresh.current = done;
    return done;
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
      setError('Failed to load the project');
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
  const [contentTab, , tabHref] = useTabParam(contentTabs, 'documents', {
    aliases: TAB_ALIASES,
    ready: !!project,
  });
  const assistantAvailable = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  const activeTab = onExport ? 'export' : onSettings && canManage ? 'settings' : contentTab;

  // A non-maintainer who lands on a settings URL has nothing to manage; bounce
  // them back to the document view rather than show an empty Settings panel.
  // A maintainers-only `?tab=` falls back to Documents (useTabParam). Either
  // way the reader is told why, as the shared guard (useManagedProject) does.
  const tabParam = new URLSearchParams(location.search).get('tab');
  useEffect(() => {
    if (!project || canManage) return;
    if (onSettings) {
      notifyNotAMaintainer();
      navigate(`/projects/${projectId}`, { replace: true });
    } else if (isMaintainerTab(tabParam)) {
      notifyNotAMaintainer();
    }
  }, [onSettings, tabParam, project, canManage, projectId, navigate]);

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

  if (loading || (!project && !error)) return <Loading />;

  if (error || !project) {
    return (
      <LoadError className={FORM_PAGE_WIDTH} onRetry={() => fetchData(live.current)}>
        {error || 'The requested project could not be found.'}
      </LoadError>
    );
  }

  // A project with nothing to open yet: its name, and why, in place of the
  // tabs, which would each lead somewhere empty.
  const notice = (children) => (
    <div className={FORM_PAGE_WIDTH}>
      <Breadcrumb className="mb-2" items={[{ label: 'Projects', to: '/projects', fixed: true }]} />
      {/* The name takes its own direction inside a heading that stays with
          the chrome, as the tab strip's does. */}
      <h1 className="flex items-center gap-3 font-text text-[1.75rem] font-bold leading-tight">
        <ProjectTartan project={project} size={32} className="shrink-0" />
        <span dir="auto" className="min-w-0 truncate">
          {project.name}
        </span>
      </h1>
      <Notice role="status" icon={null} className="mt-4">
        {children}
      </Notice>
    </div>
  );

  if (unfinishedImport && !(canManage && importResumeTo)) {
    return notice(
      <>
        The {unfinishedImport.kind} import
        {unfinishedImport.source ? ` of “${unfinishedImport.source}”` : ''} did not finish.
        {canManage ? ' Continuing it…' : ' A project maintainer can finish it.'}
      </>,
    );
  }

  if (needsSetupNotice) {
    return notice(<>This project is not set up for IGT. A project maintainer can set it up.</>);
  }

  const at = `/projects/${projectId}`;
  const tabs = [
    { value: 'documents', label: 'Documents', to: tabHref(at, 'documents') },
    { value: 'search', label: 'Search', to: tabHref(at, 'search') },
    { value: 'guidelines', label: 'Guidelines', to: tabHref(at, 'guidelines') },
    { value: 'bulk', label: 'Bulk Edit', to: tabHref(at, 'bulk'), show: canManage },
    { value: 'validate', label: 'Validation', to: tabHref(at, 'validate'), show: canManage },
    { value: 'activity', label: 'Activity', to: tabHref(at, 'activity'), show: canManage },
    // Offered only when an assistant is online. The tab itself still renders
    // when it is the active one, so a link to a past conversation opens
    // whether or not one is running: this hides the invitation, not the
    // conversations.
    {
      value: 'assistant',
      label: 'Assistant',
      to: tabHref(at, 'assistant'),
      show: assistantAvailable,
      alsoWhenActive: true,
    },
    { value: 'export', label: 'Export', to: `${at}/export` },
    // Entered at its first section. The path drives the panel.
    { value: 'settings', label: 'Settings', to: `${at}/general`, show: canManage },
  ];

  // Only the active tab's body is mounted, as the tab widget's own panels did.
  let body = null;
  if (activeTab === 'documents') {
    body = (
      <DocumentList
        documents={documents}
        project={project}
        projectId={projectId}
        client={client}
        canManage={canManage}
        canWrite={canWrite}
        onDocumentCreated={handleDocumentCreated}
      />
    );
  } else if (activeTab === 'search') {
    body = <ProjectSearch project={project} projectId={projectId} client={client} />;
  } else if (activeTab === 'bulk' && canManage) {
    body = <ProjectBulkEdit project={project} projectId={projectId} client={client} />;
  } else if (activeTab === 'validate' && canManage) {
    // The same width as plaid-ud's and plaid-umr's Validation.
    body = (
      <div className={FORM_PAGE_WIDTH}>
        <ProjectValidation
          project={project}
          projectId={projectId}
          client={client}
          onProjectUpdate={refreshProject}
        />
      </div>
    );
  } else if (activeTab === 'activity' && canManage) {
    body = <ProjectActivity client={client} project={project} projectId={projectId} />;
  } else if (activeTab === 'assistant') {
    body = (
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
    );
  } else if (activeTab === 'guidelines') {
    body = <GuidelinesTab client={client} projectId={projectId} canWrite={canWrite} />;
  } else if (activeTab === 'export') {
    // A form, so the narrower width, from the page's left edge.
    body = (
      <div className={FORM_PAGE_WIDTH}>
        <ProjectExport
          project={project}
          projectId={projectId}
          client={client}
          documents={documents}
          canManage={canManage}
          presetId={presetId}
          onProjectUpdate={refreshProject}
        />
      </div>
    );
  } else if (activeTab === 'settings' && canManage) {
    body = (
      <ProjectSettingsPanel
        project={project}
        projectId={projectId}
        client={client}
        section={pathSection || 'general'}
        onProjectUpdate={refreshProject}
      />
    );
  }

  return (
    <>
      <ProjectTabStrip projectId={projectId} project={project} tabs={tabs} active={activeTab} />
      <Suspended>{body}</Suspended>
    </>
  );
};
