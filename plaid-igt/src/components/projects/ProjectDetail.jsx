import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentList } from './DocumentList';
import { readInitialized } from '@/domain/igtConfig';

// Default project view: the document list. Mirrors plaid-ud — the project
// landing IS the documents, and project administration (access + settings) is
// tucked behind a maintainer-only "Project Settings" button (ProjectSettingsView
// at /projects/:id/access + /settings), not surfaced as inline tabs.
export const ProjectDetail = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
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
        <p className="mt-1 text-xs text-muted-foreground">{project.id}</p>
      </div>

      <DocumentList
        documents={documents}
        project={project}
        projectId={projectId}
        client={client}
        canManage={canManage}
        onDocumentCreated={handleDocumentCreated}
      />
    </div>
  );
};
