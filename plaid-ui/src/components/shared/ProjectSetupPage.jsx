import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { canManageProject } from '../../domain/permissions.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { humanizeError } from '../../lib/errors.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Loading } from './Loading.jsx';
import { SetupBlocked } from './SetupBlocked.jsx';

/**
 * The standalone setup page of plaid-ud and plaid-umr: the app's layers in a
 * project, what is missing of them, and the one button that adds them. The
 * Documents tab offers the same button at the door (ProjectDocumentsPage).
 * This page is what is left: the same button for a project that is missing
 * only some of its layers, and the place every "set it up" link points at.
 *
 * `layerInfo(project)` is the app's reading of the project's layers, and
 * `setup` the object the Documents tab takes, with what this page adds:
 * `{ app, adopt, blocked?, missingLabels(info), allSet, card: { title, body,
 * layers } }`. `allSet` is the line said when every layer is there, and
 * `card` describes what the button makes.
 */
export const ProjectSetupPage = ({ layerInfo, setup }) => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient, user } = useAuth();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useDocumentTitle('Configuration', project?.name);
  const documentsHref = appRoutes().documents(projectId);

  // The project as it is now: `quiet` keeps the page on screen while it is read.
  const read = async ({ quiet = false } = {}) => {
    try {
      if (!quiet) setLoading(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      setProject(await client.projects.get(projectId));
    } catch (err) {
      console.error('Failed to load the project:', err);
      if (!quiet) notifyError(humanizeError(err, 'Failed to load the project.'));
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  // Once per project. `read` is redefined every render, so naming it here
  // would read again on every render.
  useEffect(() => {
    read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const info = layerInfo(project);

  const handleSetUp = async () => {
    try {
      setSaving(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      await setup.adopt(client, project, info);
      notifySuccess(`Set up for ${setup.app}`);
      navigate(documentsHref);
    } catch (err) {
      console.error(`Failed to set the project up for ${setup.app}:`, err);
      notifyError(humanizeError(err, 'Failed to set up the project.'));
      // The layers may have landed before a later step failed. Show the
      // project as it is now, not the copy the button was pressed on.
      await read({ quiet: true });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;

  // This is the screen every "set it up" link points at, so arriving without
  // the role, or with the load failed, is a real path, and it has a way back.
  if (!project || !canManageProject(project, user)) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          {project
            ? `Only a project maintainer can set a project up for ${setup.app}.`
            : 'Failed to load the project.'}
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link to={documentsHref}>Back to documents</Link>
        </Button>
      </div>
    );
  }

  const missing = setup.missingLabels(info).join(', ');
  const blocked = info.isConfigured ? null : setup.blocked?.(info, projectId, project);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Set up {setup.app} layers</h1>
          <p className="text-sm text-muted-foreground">{project.name}</p>
          {info.isConfigured ? (
            <p className="text-sm text-success-foreground">{setup.allSet}</p>
          ) : (
            missing && <p className="text-sm text-warning-foreground">Missing: {missing}</p>
          )}
        </div>
        <Button variant="outline" asChild>
          <Link to={documentsHref}>Documents</Link>
        </Button>
      </div>

      {blocked ? (
        <SetupBlocked blocked={blocked} className="p-4" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{setup.card.title}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{setup.card.body}</p>
            <ul className="ml-5 list-disc space-y-1 text-sm">{setup.card.layers}</ul>
            {!info.isConfigured && (
              <Button className="self-start" onClick={handleSetUp} disabled={saving}>
                {saving ? 'Saving…' : `Set up for ${setup.app}`}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};
