import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Users, KeyRound, Settings } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AccessManagement } from './AccessManagement';
import { ProjectAccessTokens } from './ProjectAccessTokens';
import { ProjectSettings } from './ProjectSettings';

// Project administration, reached from the document view's "Project Settings"
// button (maintainer-only). Route-backed tabs — Access Management, Access Tokens,
// and Settings — at /projects/:id/access, /tokens, /settings, so deep links keep
// working and the active tab follows the path. Mirrors plaid-ud's settings shell.
export const ProjectSettingsView = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, client, logout } = useAuth();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const activeTab = location.pathname.endsWith('/tokens') ? 'tokens'
    : location.pathname.endsWith('/settings') ? 'settings'
      : 'access';

  // Project only — AccessManagement resolves its own members + searches the
  // directory, so the full user roster isn't fetched here.
  const fetchProject = async (showLoadingSpinner = false) => {
    try {
      if (showLoadingSpinner) setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const data = await client.projects.get(projectId);
      setProject(data);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout();
        return;
      }
      setError('Failed to load data');
      console.error('Error fetching project:', err);
    } finally {
      if (showLoadingSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    fetchProject(true);
  }, [projectId]);

  const canManage = !!user && !!project && (user.isAdmin || project.maintainers?.includes(user.id));

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

  if (!canManage) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          You don&apos;t have permission to manage this project.
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
          <Link to={`/projects/${projectId}`} className="hover:text-foreground">{project.name}</Link>
          <span>/</span>
          <span className="text-foreground">Settings</span>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
        <p className="mb-6 mt-1 text-xs text-muted-foreground">{project.id}</p>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => navigate(`/projects/${projectId}/${v}`)}>
        <TabsList className="tw">
          <TabsTrigger value="access"><Users className="h-4 w-4" /> Access Management</TabsTrigger>
          <TabsTrigger value="tokens"><KeyRound className="h-4 w-4" /> Access Tokens</TabsTrigger>
          <TabsTrigger value="settings"><Settings className="h-4 w-4" /> Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="access">
          <AccessManagement
            project={project}
            user={user}
            projectId={projectId}
            client={client}
            onDataUpdate={() => fetchProject()}
          />
        </TabsContent>
        <TabsContent value="tokens">
          <ProjectAccessTokens />
        </TabsContent>
        <TabsContent value="settings">
          <ProjectSettings project={project} projectId={projectId} client={client} />
        </TabsContent>
      </Tabs>
    </div>
  );
};
