import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { getUmrLayerInfo, missingUmrLayerLabels } from '../../utils/umrLayerUtils.js';
import { adoptSubstrate } from '../../domain/umrProjectSetup.js';
import { notifySuccess, notifyError, humanizeError } from '../../utils/feedback.jsx';
import { canManageProject } from '@ui/domain/permissions.js';
import { udProjectUrl } from '@ui/domain/siblingApps.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';

// The standalone /configuration page: the layer setup for a project that is
// not yet annotated for UMR. It is where the document list sends a maintainer
// who opens such a project.
//
// There are two cases and only two. A project with a substrate (a text layer
// with sentences and words, made by Plaid IGT or Plaid UD, or by this app's New
// project dialog) gets UMR's own layers added beside it. A project with no
// substrate gets nothing: text and tokens are made in IGT or UD, never here.
export const ProjectConfiguration = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient, user } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useDocumentTitle('Configuration', project?.name);

  const fetchProject = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const data = await client.projects.get(projectId);
      setProject(data);
      return data;
    } catch (err) {
      console.error('Failed to load project configuration:', err);
      notifyError('Failed to load the project.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  // Once per project. `fetchProject` is redefined every render, so naming it
  // here would refetch on every render.
  useEffect(() => {
    fetchProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const canConfigure = canManageProject(project, user);

  const handleAdopt = async () => {
    try {
      setSaving(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      await adoptSubstrate(client, getUmrLayerInfo(project));
      notifySuccess('Layers saved');
      navigate(`/projects/${projectId}/documents`);
    } catch (err) {
      console.error('Failed to set the project up for UMR:', err);
      notifyError(humanizeError(err, 'Failed to save the layers.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  // A blank screen with no way back is what a writer following a link here
  // used to get, and anyone whose project load failed after the toast had
  // gone. This screen is the one the document list redirects a maintainer
  // into, so arriving here without the role is a real path.
  if (!project || !canConfigure) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          {project
            ? "Setting a project up for UMR is a maintainer's job."
            : 'This project could not be loaded.'}
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/projects/${projectId}/documents`}>Back to Documents</Link>
        </Button>
      </div>
    );
  }

  const info = getUmrLayerInfo(project);
  // A substrate is a text layer with sentences and words in it. Everything
  // below it is UMR's own and this page can create it.
  const hasSubstrate = !!info.textLayer && !!info.sentenceTokenLayer && !!info.wordTokenLayer;
  const missingLabels = missingUmrLayerLabels(info.missingLayers).join(', ');

  const statusLine = info.isConfigured ? (
    <p className="text-sm text-green-700">Every UMR layer is set up.</p>
  ) : (
    missingLabels && <p className="text-sm text-amber-700">Missing: {missingLabels}</p>
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Set up UMR layers</h1>
          <p className="text-sm text-muted-foreground">{project.name}</p>
          {statusLine}
        </div>
        <Button variant="outline" asChild>
          <Link to={`/projects/${projectId}/documents`}>Documents</Link>
        </Button>
      </div>

      {hasSubstrate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">UMR layers</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              This project has a text layer with sentences and words. UMR&apos;s own layers are
              added beside them. Layers that already exist are reused, and the text, the sentences
              and the words are left as they are.
            </p>
            <ul className="ml-5 list-disc space-y-1 text-sm">
              <li>
                <span className="font-medium">UMR nodes</span> token layer, one token per anchor
              </li>
              <li>
                <span className="font-medium">UMR concepts</span> span layer, one span per node
              </li>
              <li>
                <span className="font-medium">UMR relations</span> relation layer, sentence-level
                edges
              </li>
              <li>
                <span className="font-medium">UMR document graph</span> relation layer, temporal,
                modal and coreference triples
              </li>
            </ul>
            <Button className="self-start" onClick={handleAdopt} disabled={saving}>
              {saving ? 'Saving…' : 'Set up for UMR'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="flex flex-col items-start gap-3 text-sm">
            <p className="font-medium">No text to annotate</p>
            <p className="text-muted-foreground">
              This project has no sentences or words. Text and tokens are made in Plaid IGT or Plaid
              UD, and read here. A project made with New UMR project here comes with them.
            </p>
            <Button variant="outline" size="sm" asChild>
              <a href={udProjectUrl(projectId)}>Open in Plaid UD</a>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
