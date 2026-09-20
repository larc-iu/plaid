import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { adoptSubstrate } from '../../domain/umrProjectSetup.js';
import { notifySuccess, notifyError, humanizeError } from '../../utils/feedback.jsx';
import { udProjectUrl } from '@ui/domain/siblingApps.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { Button, buttonVariants } from '@ui/components/ui/button';
import { DocumentTable } from '@ui/components/shared/DocumentTable.jsx';

export const DocumentList = () => {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  useDocumentTitle(project?.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settingUp, setSettingUp] = useState(false);
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

  // Setting the project up for UMR belongs at the door, and a maintainer is
  // offered it right here rather than sent to a page for it: there is nothing
  // on that page to decide, UMR's layers being the same in every project. What
  // the click is NOT is automatic — the project list is every project the user
  // can read, so opening one to look inside must not write layers into
  // somebody else's project.
  const layerInfo = getUmrLayerInfo(project);
  const configured = layerInfo.isConfigured;
  const canManage = canManageProject(project, user);
  // A substrate is a text layer with sentences and words in it. Text and
  // tokens are made in IGT or UD, never here, so without one there is nothing
  // for this app to add.
  const hasSubstrate =
    !!layerInfo.textLayer && !!layerInfo.sentenceTokenLayer && !!layerInfo.wordTokenLayer;

  const handleSetUp = async () => {
    try {
      setSettingUp(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      await adoptSubstrate(client, layerInfo);
      notifySuccess('Layers saved');
      await fetchProjectAndDocuments();
    } catch (err) {
      console.error('Failed to set the project up for UMR:', err);
      notifyError(humanizeError(err, 'Failed to save the layers.'));
    } finally {
      setSettingUp(false);
    }
  };

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

  // A maintainer gets the one button that sets the project up, or, where
  // there is no text to annotate, the way to go and make some. Everyone else
  // cannot create layers, so they get a notice rather than a control that
  // would fail for them.
  if (!configured) {
    return (
      <>
        <ProjectTabs projectId={projectId} project={project} />
        <div className="flex justify-center py-16">
          <div className="flex max-w-lg gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="flex flex-col items-start gap-3 text-sm">
              <p className="font-medium">
                {canManage && !hasSubstrate ? 'No text to annotate' : 'Not set up for UMR'}
              </p>
              {!canManage && (
                <p className="text-muted-foreground">
                  Ask a project maintainer to add UMR support.
                </p>
              )}
              {canManage && hasSubstrate && (
                <>
                  <p className="text-muted-foreground">
                    UMR&apos;s layers are added beside what is already here. The text, the sentences
                    and the words are left as they are.
                  </p>
                  <Button size="sm" onClick={handleSetUp} disabled={settingUp}>
                    {settingUp ? 'Saving…' : 'Set up for UMR'}
                  </Button>
                </>
              )}
              {canManage && !hasSubstrate && (
                <>
                  <p className="text-muted-foreground">
                    This project has no sentences or words. Text and tokens are made in Plaid IGT or
                    Plaid UD, and read here. A project made with New UMR project here comes with
                    them.
                  </p>
                  <a
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    href={udProjectUrl(projectId)}
                  >
                    Open in Plaid UD
                  </a>
                </>
              )}
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
