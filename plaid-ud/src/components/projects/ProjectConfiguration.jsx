import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import {
  UD_NAMESPACE,
  UD_SPAN_CONFIG_KEYS,
  UD_RELATION_CONFIG_KEY,
  UD_LAYER_LABELS,
  getUdLayerInfo,
} from '../../utils/udLayerUtils.js';
import { PLAID_NAMESPACE, ROLE_KEY, ROLES, findByRole } from '@larc-iu/plaid-client';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '../../utils/permissions.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';

// Span layers, in creation order, all attached to the morpheme token layer.
const SPAN_KEYS_IN_ORDER = ['form', 'lemma', 'upos', 'xpos', 'features'];
const SPAN_LAYER_NAMES = {
  form: 'Form',
  lemma: 'Lemma',
  upos: 'UPOS',
  xpos: 'XPOS',
  features: 'Features',
};

// The standalone /configuration page: the layer-structure half of project
// setup: the text layer plus the three-level token hierarchy and the
// annotation layers under it. Project-specific vocabularies, colors and locale
// live in the separate Customization settings tab (ProjectCustomization).
// Saving creates or completes the layers idempotently.
export const ProjectConfiguration = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient, user } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useDocumentTitle('Configuration', project?.name);

  const [formData, setFormData] = useState({
    textLayerType: 'existing',
    selectedTextLayerId: '',
    newTextLayerName: 'Text',
  });

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

  useEffect(() => {
    if (project && !canConfigure) {
      navigate('/projects');
    }
  }, [project, canConfigure, navigate]);

  const availableTextLayers = project?.textLayers || [];

  // Initialize the text-layer choice once project data is available.
  useEffect(() => {
    if (!project) return;
    const info = getUdLayerInfo(project);
    const existingTextLayerId = info.textLayer?.id || availableTextLayers[0]?.id || '';
    setFormData({
      textLayerType: availableTextLayers.length === 0 ? 'new' : 'existing',
      selectedTextLayerId: existingTextLayerId,
      newTextLayerName: 'Text',
    });
    // Seeded from the project. `availableTextLayers` is derived from it, so
    // naming it would re-seed the form (discarding the user's edits) whenever
    // that derived array changed identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const validateForm = () => {
    if (formData.textLayerType === 'existing' && !formData.selectedTextLayerId) {
      return 'Select a text layer or choose to create a new one.';
    }
    if (formData.textLayerType === 'new' && !formData.newTextLayerName.trim()) {
      return 'Name the new text layer.';
    }
    return '';
  };

  // Find an existing UD annotation layer (idempotent re-configuration), else null.
  const findFlagged = (layers, namespace, key) =>
    (layers || []).find((layer) => layer.config?.[namespace]?.[key] === true) || null;
  // Substrate layers are matched by their shared ROLE (findByRole, imported from
  // the client). This is also how UD adopts a substrate created by another app:
  // reuse its baseline/sentence/word and create only the layers UD needs below.

  const ensureTokenLayer = async (
    client,
    textLayerId,
    existingTextLayer,
    role,
    name,
    overlapMode,
    parentId,
  ) => {
    const existing = findByRole(existingTextLayer?.tokenLayers, role);
    if (existing) return existing;
    const created = await client.tokenLayers.create(textLayerId, name, overlapMode, parentId);
    await client.tokenLayers.setConfig(created.id, PLAID_NAMESPACE, ROLE_KEY, role);
    return created;
  };

  const ensureSpanLayer = async (
    client,
    morphemeLayerId,
    existingMorphemeLayer,
    configKey,
    name,
  ) => {
    const existing = findFlagged(existingMorphemeLayer?.spanLayers, UD_NAMESPACE, configKey);
    if (existing) return existing;
    const created = await client.spanLayers.create(morphemeLayerId, name);
    await client.spanLayers.setConfig(created.id, UD_NAMESPACE, configKey, true);
    return created;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    const validationError = validateForm();
    if (validationError) {
      notifyError(validationError);
      return;
    }

    try {
      setSaving(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }

      // Sequential awaits (not batched) are deliberate here: the
      // `ensureTokenLayer`/`ensureSpanLayer` helpers below short-circuit when a
      // UD-flagged layer already exists, which makes a partial-failure re-run
      // safe (idempotent). Wrapping these in a batch would defeat that — we
      // need the in-memory result of each ensure-check to decide the next op.
      // The trade-off (no per-step atomicity) is acceptable because re-running
      // this form picks up where it left off.
      //
      // 1. Text layer
      let textLayerId = formData.selectedTextLayerId;
      let existingTextLayer = availableTextLayers.find((l) => l.id === textLayerId) || null;
      if (formData.textLayerType === 'new') {
        const name = formData.newTextLayerName.trim() || 'Text';
        const textLayer = await client.textLayers.create(projectId, name);
        textLayerId = textLayer.id;
        existingTextLayer = null;
      }
      await client.textLayers.setConfig(textLayerId, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);

      // 2. Token-layer hierarchy, tagged by shared role: sentence (partitioning) >
      //    word (non-overlapping) > syntactic-word (any). UD's "Morphemes" layer
      //    holds syntactic words, so its role is `syntactic-word` (a sibling of
      //    IGT's `morpheme` layer under the shared word layer).
      const sentenceLayer = await ensureTokenLayer(
        client,
        textLayerId,
        existingTextLayer,
        ROLES.SENTENCE,
        'Sentences',
        'partitioning',
        undefined,
      );
      const wordLayer = await ensureTokenLayer(
        client,
        textLayerId,
        existingTextLayer,
        ROLES.WORD,
        'Tokens',
        'non-overlapping',
        sentenceLayer.id,
      );
      const morphemeLayer = await ensureTokenLayer(
        client,
        textLayerId,
        existingTextLayer,
        ROLES.SYNTACTIC_WORD,
        'Words',
        'any',
        wordLayer.id,
      );

      // 3. Annotation span layers, all under the syntactic-word ("Morphemes") layer
      const existingMorphemeLayer = findByRole(
        existingTextLayer?.tokenLayers,
        ROLES.SYNTACTIC_WORD,
      );
      const spanLayers = {};
      for (const key of SPAN_KEYS_IN_ORDER) {
        spanLayers[key] = await ensureSpanLayer(
          client,
          morphemeLayer.id,
          existingMorphemeLayer,
          UD_SPAN_CONFIG_KEYS[key],
          SPAN_LAYER_NAMES[key],
        );
      }

      // 4. Dependency relation layer under the lemma span layer
      const existingRelationLayer = findFlagged(
        spanLayers.lemma?.relationLayers,
        UD_NAMESPACE,
        UD_RELATION_CONFIG_KEY,
      );
      if (!existingRelationLayer) {
        const relationLayer = await client.relationLayers.create(
          spanLayers.lemma.id,
          'Dependency Relations',
        );
        await client.relationLayers.setConfig(
          relationLayer.id,
          UD_NAMESPACE,
          UD_RELATION_CONFIG_KEY,
          true,
        );
      }

      notifySuccess('Layers saved');
      // Setup/repair done — head back to the project's document view.
      navigate(`/projects/${projectId}/documents`);
    } catch (err) {
      console.error('Failed to save configuration:', err);
      notifyError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!project || !canConfigure) {
    return null;
  }

  const info = getUdLayerInfo(project);
  const missingLabels = info.missingLayers?.length
    ? info.missingLayers.map((key) => UD_LAYER_LABELS[key] || key).join(', ')
    : '';

  const statusLine = info.isConfigured ? (
    <p className="text-sm text-green-700">Every Universal Dependencies layer is set up.</p>
  ) : (
    missingLabels && <p className="text-sm text-amber-700">Missing: {missingLabels}</p>
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Configure UD layers</h1>
          <p className="text-sm text-muted-foreground">{project.name}</p>
          {statusLine}
        </div>
        <Button variant="outline" asChild>
          <Link to={`/projects/${projectId}/documents`}>Documents</Link>
        </Button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Text layer</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Two radios rather than a select: there are exactly two choices,
                and one of them disables itself when the project has no layers
                to reuse. */}
            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm has-[:disabled]:opacity-50">
                <input
                  type="radio"
                  name="textLayerType"
                  className="h-4 w-4 accent-primary"
                  value="existing"
                  checked={formData.textLayerType === 'existing'}
                  disabled={availableTextLayers.length === 0}
                  onChange={() => setFormData((prev) => ({ ...prev, textLayerType: 'existing' }))}
                />
                Use existing
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="textLayerType"
                  className="h-4 w-4 accent-primary"
                  value="new"
                  checked={formData.textLayerType === 'new'}
                  onChange={() => setFormData((prev) => ({ ...prev, textLayerType: 'new' }))}
                />
                Create new
              </label>
            </div>

            {formData.textLayerType === 'existing' ? (
              <div className="flex max-w-md flex-col gap-1.5">
                <Label htmlFor="text-layer">Text layer</Label>
                <Select
                  value={formData.selectedTextLayerId || undefined}
                  onValueChange={(value) =>
                    setFormData((prev) => ({ ...prev, selectedTextLayerId: value || '' }))
                  }
                >
                  <SelectTrigger id="text-layer">
                    <SelectValue placeholder="Select a text layer" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTextLayers.map((layer) => (
                      <SelectItem key={layer.id} value={layer.id}>
                        {layer.name} ({layer.id})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="flex max-w-md flex-col gap-1.5">
                <Label htmlFor="new-text-layer">New text layer name</Label>
                <Input
                  id="new-text-layer"
                  name="newTextLayerName"
                  value={formData.newTextLayerName}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, newTextLayerName: e.target.value }))
                  }
                  placeholder="Text"
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Token hierarchy and annotations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Saving creates, or completes, the three-layer token hierarchy and the annotation
              layers below. Layers that already exist are reused, including ones another app set up.
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
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => navigate(-1)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </div>
  );
};
