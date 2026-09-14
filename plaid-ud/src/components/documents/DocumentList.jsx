import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Info, Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentForm } from './DocumentForm';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { Button } from '@ui/components/ui/button';
import { DocumentTable } from '@ui/components/shared/DocumentTable.jsx';

export const DocumentList = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  useDocumentTitle(project?.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const { user, getClient, logout } = useAuth();

  const fetchProjectAndDocuments = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }

      // Fetch project and its documents (documents are no longer embedded
      // on the project; they come from the dedicated listDocuments endpoint).
      const [projectData, docsList] = await Promise.all([
        client.projects.get(projectId),
        client.projects.listDocuments(projectId),
      ]);
      setProject(projectData);
      setDocuments(docsList || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Clear the rejected token before redirecting, else /login bounces back.
        logout();
        return;
      }
      setError('Failed to load project and documents');
      console.error('Error fetching project:', err);
    } finally {
      setLoading(false);
    }
  };

  // Once per project. `fetchProjectAndDocuments` is redefined every render,
  // so naming it here would refetch on every render.
  useEffect(() => {
    fetchProjectAndDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // A row links to the Annotate tab by default; but a document with no tokens
  // yet has nothing to annotate (the tab would just say "tokenize first"), so
  // point it at the Text Editor. Only divert once word counts have loaded and
  // confirm zero tokens — while they're still loading we keep the default so a
  // tokenized doc clicked early isn't mis-routed.
  const rowHref = (documentId, { wordCount, hasWordLayer, wordsLoading }) => {
    const knownEmpty = hasWordLayer && !wordsLoading && (wordCount ?? 0) === 0;
    return `/projects/${projectId}/documents/${documentId}/${knownEmpty ? 'edit' : 'annotate'}`;
  };

  // Setting the project up for UD belongs HERE, at the door: a project is
  // either set up or it isn't, and finding that out is what clicking into it
  // should tell you. Opening a document is far too late — that used to bounce
  // the reader out of the editor mid-task.
  const configured = getUdLayerInfo(project).isConfigured;
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

  // A maintainer is on their way to the setup page (the effect above). Everyone
  // else can't create layers, so they get a notice rather than a dead-end
  // redirect into a wizard they cannot complete.
  if (!configured) {
    return (
      <>
        <ProjectTabs projectId={projectId} project={project} />
        <div className="flex justify-center py-16">
          <div className="flex max-w-lg gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium">Not set up for UD</p>
              <p className="mt-1 text-muted-foreground">
                Ask a project maintainer to add UD support.
              </p>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Writers (and up) create/delete documents. Readers get a view-only list.
  // (Search, Project Settings, and Import/Export now live in the ProjectTabs bar.)
  const canEdit = canEditProject(project, user);

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <div>
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Documents in {project.name}</h1>
          {canEdit && (
            <Button onClick={() => setShowCreateForm(true)}>
              <Plus className="h-4 w-4" /> New document
            </Button>
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

        <DocumentForm
          projectId={projectId}
          isOpen={showCreateForm}
          onClose={() => setShowCreateForm(false)}
        />

        <DocumentTable
          documents={documents}
          client={getClient()}
          projectId={projectId}
          wordLayerId={getUdLayerInfo(project).morphemeTokenLayer?.id}
          href={rowHref}
          defaultSort={{ key: 'name', dir: 'asc' }}
        />
      </div>
    </>
  );
};
