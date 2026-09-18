import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { buttonVariants } from '@ui/components/ui/button';
import { DocumentTable } from '@ui/components/shared/DocumentTable.jsx';

export const DocumentList = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  useDocumentTitle(project?.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { user, getClient, logout } = useAuth();

  const fetchProjectAndDocuments = async () => {
    try {
      setLoading(true);
      const client = getClient();
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
        logout();
        return;
      }
      setError('Failed to load project and documents');
      console.error('Error fetching project:', err);
    } finally {
      setLoading(false);
    }
  };

  // Once per project. `fetchProjectAndDocuments` is redefined every render.
  useEffect(() => {
    fetchProjectAndDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const rowHref = (documentId) => `/projects/${projectId}/documents/${documentId}/annotate`;

  // Setting the project up for UMR belongs at the door: a maintainer opening
  // an unconfigured project is sent to the layer setup page.
  const layerInfo = getUmrLayerInfo(project);
  const configured = layerInfo.isConfigured;
  const canManage = canManageProject(project, user);
  useEffect(() => {
    if (project && !configured && canManage) {
      navigate(`/projects/${projectId}/configuration`, { replace: true });
    }
  }, [project, configured, canManage, projectId, navigate]);

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!project) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        Project not found
      </div>
    );
  }

  // Everyone but a maintainer gets a notice rather than a wizard they cannot
  // complete.
  if (!configured) {
    return (
      <>
        <ProjectTabs projectId={projectId} project={project} />
        <div className="flex justify-center py-16">
          <div className="flex max-w-lg gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium">Not set up for UMR</p>
              <p className="mt-1 text-muted-foreground">
                Ask a project maintainer to add UMR support.
              </p>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Documents arrive through .umr import. Text is edited in IGT or UD, so
  // there is no New document button here.
  const canEdit = canEditProject(project, user);

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <div>
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Documents in {project.name}</h1>
          {canEdit && (
            <Link to={`/projects/${projectId}/import-export`} className={buttonVariants()}>
              Import .umr
            </Link>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <DocumentTable
          documents={documents}
          client={getClient()}
          projectId={projectId}
          wordLayerId={layerInfo.wordTokenLayer?.id}
          href={rowHref}
          defaultSort={{ key: 'name', dir: 'asc' }}
        />
      </div>
    </>
  );
};
