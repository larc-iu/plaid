import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { FileText, Search, Replace, ShieldCheck, Bot, Download, Settings } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentList } from './DocumentList';
import { ProjectSearch } from './search/ProjectSearch.jsx';
import { ProjectBulkEdit } from './bulk/ProjectBulkEdit.jsx';
import { ProjectValidation } from './validate/ProjectValidation.jsx';
import { ProjectAssistant } from './assistant/ProjectAssistant.jsx';
import { ProjectExport } from './ProjectExport.jsx';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { readInitialized } from '@/domain/igtConfig';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useTabParam, tabTo } from '@/hooks/useTabParam';
import { cn } from '@/lib/utils';

// The settings sections live behind these path suffixes; keeping them in the
// URL means deep links and the back button still land on the right section.
const SETTINGS_SECTIONS = ['general', 'lexicon', 'annotation', 'access', 'services'];

// The content tabs, which ride in `?tab=` on the project page (Bulk Edit is
// maintainers-only; Assistant is open to everyone, since the assistant acts
// under the user's own permissions). Settings is the last tab in the bar but
// is path-backed (see above) because its sections are pages of their own.
const CONTENT_TABS = ['documents', 'search', 'bulk', 'validate', 'assistant'];

// Title-bar labels for the settings sections (match ProjectSettingsPanel).
const SECTION_TITLES = {
  general: 'General',
  lexicon: 'Lexicon',
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
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchData = async (showLoadingSpinner = false) => {
    try {
      if (showLoadingSpinner) setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const [projectData, docsList] = await Promise.all([
        client.projects.get(projectId),
        client.projects.listDocuments(projectId),
      ]);
      setProject(projectData);
      setDocuments(docsList || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Clear the rejected token before leaving, else /login bounces back.
        logout('expired');
        return;
      }
      setError('Failed to load data');
      console.error('Error fetching data:', err);
    } finally {
      if (showLoadingSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(true);
  }, [projectId]);

  const canManage = !!user && !!project && (user.isAdmin || project.maintainers?.includes(user.id));
  // Creating/editing documents needs WRITE, which writers have but managing
  // (settings/access) does not. Gate document-create on this so a reader isn't
  // shown a button that 403s on submit.
  const canWrite = canManage || (!!user && !!project && project.writers?.includes(user.id));

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
  const [contentTab, setContentTab] = useTabParam(CONTENT_TABS, 'documents');
  const activeTab = onExport
    ? 'export'
    : onSettings && canManage
      ? 'settings'
      : (contentTab === 'bulk' || contentTab === 'validate') && !canManage
        ? 'documents'
        : contentTab;

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

  const handleDocumentCreated = (newDocument) => {
    setDocuments((prev) => [...prev, newDocument]);
  };

  if (loading) {
    return (
      <div className="tw flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error || 'The requested project could not be found.'}
        </div>
      </div>
    );
  }

  if (needsSetupNotice) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
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
      <div className="tw">
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
            navigate(
              v === 'documents' ? `/projects/${projectId}` : `/projects/${projectId}?tab=${v}`,
            );
          } else {
            setContentTab(v);
          }
        }}
      >
        <TabsList className="tw mb-2">
          <TabsTrigger
            value="documents"
            to={tabTo(`/projects/${projectId}`, 'documents', 'documents')}
          >
            <FileText className="h-4 w-4" /> Documents
          </TabsTrigger>
          <TabsTrigger value="search" to={tabTo(`/projects/${projectId}`, 'search', 'documents')}>
            <Search className="h-4 w-4" /> Search
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="bulk" to={tabTo(`/projects/${projectId}`, 'bulk', 'documents')}>
              <Replace className="h-4 w-4" /> Bulk Edit
            </TabsTrigger>
          )}
          {canManage && (
            <TabsTrigger
              value="validate"
              to={tabTo(`/projects/${projectId}`, 'validate', 'documents')}
            >
              <ShieldCheck className="h-4 w-4" /> Validation
            </TabsTrigger>
          )}
          <TabsTrigger
            value="assistant"
            to={tabTo(`/projects/${projectId}`, 'assistant', 'documents')}
          >
            <Bot className="h-4 w-4" /> Assistant
          </TabsTrigger>
          <TabsTrigger value="export" to={`/projects/${projectId}/export`}>
            <Download className="h-4 w-4" /> Export
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="settings" to={`/projects/${projectId}/access`}>
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
            <ProjectBulkEdit project={project} projectId={projectId} client={client} />
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="validate">
            <ProjectValidation
              project={project}
              projectId={projectId}
              client={client}
              onProjectUpdate={() => fetchData()}
            />
          </TabsContent>
        )}
        <TabsContent value="assistant">
          <ProjectAssistant
            projectId={projectId}
            projectName={project?.name}
            client={client}
            userId={user?.id}
            canWrite={canWrite}
          />
        </TabsContent>
        <TabsContent value="export">
          <ProjectExport
            project={project}
            projectId={projectId}
            client={client}
            documents={documents}
            canManage={canManage}
            presetId={presetId}
            onProjectUpdate={() => fetchData()}
          />
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
              onProjectUpdate={() => fetchData()}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
};
