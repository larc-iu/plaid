import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth.js';
import { canEditProject, canManageProject } from '../../domain/permissions.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { humanizeError } from '../../lib/errors.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';
import { Button } from '../ui/button';
import { DocumentTable } from './DocumentTable.jsx';
import { Loading } from './Loading.jsx';
import { Notice } from './Notice.jsx';

/**
 * A project's Documents tab in plaid-ud and plaid-umr: the list of documents,
 * or, on a project the app has no layers in yet, the door that sets it up.
 *
 * Setting a project up belongs HERE, at the door: a project is either set up
 * or it isn't, and finding that out is what clicking into it should tell you.
 * A maintainer is offered the setup right here rather than sent to a page for
 * it, because there is nothing on that page to decide. What the click is NOT
 * is automatic: the project list is every project the user can read, so
 * opening one to look inside must not write layers into somebody else's
 * project. Everyone else cannot create layers, so they get a notice rather
 * than a control that would fail for them.
 *
 * The app's parts, as data:
 * - `tabs`: the app's project tab strip component.
 * - `layerInfo(project)`: the app's reading of the project's layers, with
 *   `isConfigured`.
 * - `setup`: `{ app, note, adopt(client, project, info), blocked?(info, projectId) }`.
 *   `app` is the short name the notice uses ("Not set up for UD"), `note` the
 *   line a maintainer reads above the button, `adopt` does the setting up.
 *   `blocked(info, projectId)`, when it returns `{ title, body, action }`, is what a
 *   maintainer sees instead of the button: the project lacks something the
 *   app cannot make.
 * - `tableLayers(info)`: `{ wordLayerId, seedLayerId }` for `DocumentTable`.
 * - `rowHref(projectId, documentId, counts)`: where a row opens.
 * - `newDocument`: a component drawn beside the heading for a writer, given
 *   `{ projectId, documents }`.
 */
export const ProjectDocumentsPage = ({
  tabs: Tabs,
  layerInfo,
  setup,
  tableLayers,
  rowHref,
  newDocument: NewDocument,
}) => {
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
      // Documents are not embedded on the project. They come from their own
      // listing.
      const [projectData, docsList] = await Promise.all([
        client.projects.get(projectId),
        client.projects.listDocuments(projectId),
      ]);
      setProject(projectData);
      setDocuments(docsList || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Clear the rejected token before redirecting, else the login page
        // bounces back.
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

  const info = layerInfo(project);
  const canManage = canManageProject(project, user);

  const handleSetUp = async () => {
    try {
      setSettingUp(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      await setup.adopt(client, project, info);
      notifySuccess('Layers saved');
      await fetchProjectAndDocuments();
    } catch (err) {
      console.error(`Failed to set the project up for ${setup.app}:`, err);
      notifyError(humanizeError(err, 'Failed to save the layers.'));
    } finally {
      setSettingUp(false);
    }
  };

  if (loading) return <Loading />;

  if (!project) {
    return (
      <Notice tone="error" role="alert">
        Project not found
      </Notice>
    );
  }

  if (!info.isConfigured) {
    const blocked = canManage ? setup.blocked?.(info, projectId) : null;
    return (
      <>
        <Tabs projectId={projectId} project={project} />
        <div className="flex justify-center py-16">
          <Notice tone="warning" icon={Info} className="max-w-lg gap-3 p-4">
            <div className="flex flex-col items-start gap-3">
              <p className="font-medium">
                {blocked ? blocked.title : `Not set up for ${setup.app}`}
              </p>
              {!canManage && (
                <p className="text-muted-foreground">
                  Ask a project maintainer to add {setup.app} support.
                </p>
              )}
              {canManage && !blocked && (
                <>
                  <p className="text-muted-foreground">{setup.note}</p>
                  <Button size="sm" onClick={handleSetUp} disabled={settingUp}>
                    {settingUp ? 'Saving…' : `Set up for ${setup.app}`}
                  </Button>
                </>
              )}
              {blocked && (
                <>
                  <p className="text-muted-foreground">{blocked.body}</p>
                  {blocked.action}
                </>
              )}
            </div>
          </Notice>
        </div>
      </>
    );
  }

  // Writers (and up) create documents. Readers get a view-only list.
  const canEdit = canEditProject(project, user);
  const { wordLayerId, seedLayerId } = tableLayers(info);

  return (
    <>
      <Tabs projectId={projectId} project={project} />

      <div>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Documents in {project.name}</h2>
          {canEdit && NewDocument && <NewDocument projectId={projectId} documents={documents} />}
        </div>

        {error && (
          <Notice tone="error" role="alert" className="mb-4">
            {error}
          </Notice>
        )}

        <DocumentTable
          documents={documents}
          client={getClient()}
          projectId={projectId}
          wordLayerId={wordLayerId}
          seedLayerId={seedLayerId}
          href={(documentId, counts) => rowHref(projectId, documentId, counts)}
          defaultSort={{ key: 'updated', dir: 'desc' }}
        />
      </div>
    </>
  );
};
