import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { getUdLayerInfo, UD_LAYER_LABELS } from '../../utils/udLayerUtils.js';
import { ROLES, findByRole } from '@larc-iu/plaid-client';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { adoptSubstrate } from '../../domain/udProjectSetup.js';
import { canManageProject } from '@ui/domain/permissions.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';

// The standalone /configuration page: the layer-structure half of project
// setup, the text layer plus the three-level token hierarchy and the
// annotation layers under it. Project-specific vocabularies, colors and locale
// live in the separate Customization settings tab (ProjectCustomization).
//
// There is nothing to choose here. The text layer UD builds on is the one
// carrying the baseline role, which is the one every Plaid app makes, and the
// layers below it are the same in every UD project. Setting a project up is
// therefore one button, and the document list offers it there too, at the door
// where a maintainer meets an unconfigured project. This page is what is left:
// the same button for a project that is missing only some of its layers, and
// the place every "configure the project" link in the app points at.
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
      if (!client) {
        throw new Error('Not authenticated');
      }
      const data = await client.projects.get(projectId);
      setProject(data);
      return data;
    } catch (err) {
      console.error('Failed to load project configuration:', err);
      notifyError(err, 'Failed to load the project');
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

  const handleSetUp = async () => {
    try {
      setSaving(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }
      await adoptSubstrate(client, project);
      notifySuccess('Set up for UD');
      // Setup/repair done — head back to the project's document view.
      navigate(`/projects/${projectId}/documents`);
    } catch (err) {
      console.error('Failed to set the project up for UD:', err);
      notifyError(err, 'Failed to set up the project');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Loading />;
  }

  // A blank screen with no way back is what a writer following a link here
  // used to get, and anyone whose project load failed after the toast had
  // gone. This screen is the one the Documents tab links a maintainer to, so
  // arriving here without the role is a real path.
  if (!project || !canConfigure) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          {project
            ? 'Only a project maintainer can set a project up for UD.'
            : 'Failed to load the project.'}
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/projects/${projectId}/documents`}>Back to documents</Link>
        </Button>
      </div>
    );
  }

  const info = getUdLayerInfo(project);
  const missingLabels = info.missingLayers?.length
    ? info.missingLayers.map((key) => UD_LAYER_LABELS[key] || key).join(', ')
    : '';

  // Two text layers with no baseline role between them is not a project any
  // Plaid app makes, and UD cannot tell which one it is meant to annotate.
  const textLayers = project.textLayers || [];
  const ambiguousText = !findByRole(textLayers, ROLES.BASELINE) && textLayers.length > 1;

  const statusLine = info.isConfigured ? (
    <p className="text-sm text-success">Every Universal Dependencies layer is set up.</p>
  ) : (
    missingLabels && <p className="text-sm text-warning-foreground">Missing: {missingLabels}</p>
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Set up UD layers</h1>
          <p className="text-sm text-muted-foreground">{project.name}</p>
          {statusLine}
        </div>
        <Button variant="outline" asChild>
          <Link to={`/projects/${projectId}/documents`}>Documents</Link>
        </Button>
      </div>

      {ambiguousText ? (
        <Notice tone="warning" icon={Info} className="gap-3 p-4">
          <div className="flex flex-col items-start gap-1">
            <p className="font-medium">More than one text layer</p>
            <p className="text-muted-foreground">
              UD annotates one text layer, and this project has {textLayers.length}. A project made
              in Plaid IGT, Plaid UD or Plaid UMR has one.
            </p>
          </div>
        </Notice>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Token hierarchy and annotations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              The three-layer token hierarchy and the annotation layers below it are created, or
              completed. Layers that already exist are reused, including ones another app set up,
              and the text and the tokens in them are left as they are.
            </p>
            <ul className="ml-5 list-disc space-y-1 text-sm">
              <li>
                <span className="font-medium">Sentences</span> token layer (partitioning)
              </li>
              <li>
                <span className="font-medium">Tokens</span> token layer (non-overlapping, nested in
                sentences): orthographic tokens
              </li>
              <li>
                <span className="font-medium">Words</span> token layer (overlap allowed, nested in
                tokens): where annotations live. A token splits into one or more words (multi-word
                tokens)
              </li>
              <li>Span layers on words: Form, Lemma, UPOS, XPOS, Features</li>
              <li>Dependency relation layer on the Lemma layer</li>
            </ul>
            <Button className="self-start" onClick={handleSetUp} disabled={saving}>
              {saving ? 'Saving…' : 'Set up for UD'}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
