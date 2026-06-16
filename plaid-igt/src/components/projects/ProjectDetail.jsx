import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { FileText, Search, Settings } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentList } from './DocumentList';
import { ProjectSearch } from './search/ProjectSearch.jsx';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { readInitialized } from '@/domain/igtConfig';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

// The settings sections live behind these path suffixes; keeping them in the
// URL means deep links and the back button still land on the right section.
const SETTINGS_SECTIONS = ['access', 'tokens', 'services', 'settings'];

// Title-bar labels for the settings sections (match ProjectSettingsPanel).
const SECTION_TITLES = {
  access: 'Access Management',
  tokens: 'Access Tokens',
  services: 'Services',
  settings: 'Settings',
};

// Default project view: the document list, a query-engine-powered Search tab,
// and (for maintainers) a Settings tab. Settings is a real panel in this tab
// group — selecting it stays on the page and renders project administration as
// a left-side vertical tab group (ProjectSettingsPanel), route-backed by the
// /access, /tokens, /services, /settings suffixes.
export const ProjectDetail = () => {
  const { projectId } = useParams();
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
        logout();
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

  // Which top-level tab is active. Documents/Search are local UI state; the
  // Settings tab is reflected in the path so its sections are deep-linkable.
  const pathSection = SETTINGS_SECTIONS.find((s) => location.pathname.endsWith(`/${s}`)) || null;
  const onSettings = pathSection !== null;

  // Tab title: "<Section> · <Project> · Plaid IGT" on a settings section, else
  // "<Project> · Plaid IGT". Both segments are dropped while still loading.
  useDocumentTitle(onSettings ? SECTION_TITLES[pathSection] : null, project?.name);
  const [contentTab, setContentTab] = useState('documents');
  const activeTab = onSettings && canManage ? 'settings' : contentTab;

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
    setDocuments(prev => [...prev, newDocument]);
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
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error || 'The requested project could not be found.'}
        </div>
      </div>
    );
  }

  if (needsSetupNotice) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
        <div role="status" className="mt-4 rounded-md border bg-muted px-4 py-3 text-sm text-muted-foreground">
          This project hasn’t been set up for IGT yet. Ask a project maintainer to add IGT support.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="tw">
        <nav className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground">Projects</Link>
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
            navigate(`/projects/${projectId}/access`);
          } else {
            // Leaving Settings means dropping the section suffix from the URL.
            if (onSettings) navigate(`/projects/${projectId}`);
            setContentTab(v);
          }
        }}
      >
        <TabsList className="tw mb-2">
          <TabsTrigger value="documents"><FileText className="h-4 w-4" /> Documents</TabsTrigger>
          <TabsTrigger value="search"><Search className="h-4 w-4" /> Search</TabsTrigger>
          {canManage && (
            <TabsTrigger value="settings"><Settings className="h-4 w-4" /> Settings</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="documents">
          <DocumentList
            documents={documents}
            project={project}
            projectId={projectId}
            client={client}
            canManage={canManage}
            onDocumentCreated={handleDocumentCreated}
          />
        </TabsContent>
        <TabsContent value="search">
          <ProjectSearch project={project} projectId={projectId} client={client} />
        </TabsContent>
        {canManage && (
          <TabsContent value="settings">
            <ProjectSettingsPanel
              project={project}
              projectId={projectId}
              client={client}
              user={user}
              section={pathSection || 'access'}
              onSectionChange={(s) => navigate(`/projects/${projectId}/${s}`)}
              onProjectUpdate={() => fetchData()}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
};
