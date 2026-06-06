import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DocumentList } from './DocumentList';

// Default project view: the document list. Mirrors plaid-ud — the project
// landing IS the documents, and project administration (access + settings) is
// tucked behind a maintainer-only "Project Settings" button (ProjectSettingsView
// at /projects/:id/access + /settings), not surfaced as inline tabs.
export const ProjectDetail = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, client } = useAuth();
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
        navigate('/login');
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

  // Unconfigured projects go to the setup wizard.
  useEffect(() => {
    if (project && !project.config?.plaid?.initialized) {
      navigate(`/projects/${projectId}/setup`, { replace: true });
    }
  }, [project, projectId, navigate]);

  const canManage = !!user && !!project && (user.isAdmin || project.maintainers?.includes(user.id));

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

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="tw">
        <nav className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground">Projects</Link>
          <span>/</span>
          <span className="text-foreground">{project.name}</span>
        </nav>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{project.id}</p>
          </div>
          {canManage && (
            <Button variant="outline" onClick={() => navigate(`/projects/${projectId}/access`)}>
              <Settings className="h-4 w-4" /> Project Settings
            </Button>
          )}
        </div>
      </div>

      <DocumentList
        documents={documents}
        projectId={projectId}
        client={client}
        onDocumentCreated={handleDocumentCreated}
      />
    </div>
  );
};
