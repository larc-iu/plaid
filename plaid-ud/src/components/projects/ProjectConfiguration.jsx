import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import {
  UD_NAMESPACE,
  UD_TEXT_CONFIG_KEY,
  UD_TOKEN_CONFIG_KEYS,
  UD_SPAN_CONFIG_KEYS,
  UD_RELATION_CONFIG_KEY,
  UD_LAYER_LABELS,
  getUdLayerInfo
} from '../../utils/udLayerUtils.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '../../utils/permissions.js';
import {
  Container, Title, Text, Button, Group, Stack, Paper, Radio, Select, TextInput, List, Center, Loader,
} from '@mantine/core';

// Span layers, in creation order, all attached to the morpheme token layer.
const SPAN_KEYS_IN_ORDER = ['form', 'lemma', 'upos', 'xpos', 'features'];
const SPAN_LAYER_NAMES = {
  form: 'Form',
  lemma: 'Lemma',
  upos: 'UPOS',
  xpos: 'XPOS',
  features: 'Features'
};

// "UD Configuration" tab: the layer-structure half of project setup — the text
// layer plus the three-level token hierarchy and the annotation layers under it.
// Project-specific vocabularies/colors/locale live in the separate Customization
// tab (ProjectCustomization). Saving creates/completes the layers idempotently.
export const ProjectConfiguration = ({ embedded = false }) => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient, user } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    textLayerType: 'existing',
    selectedTextLayerId: '',
    newTextLayerName: 'Text'
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
      notifyError('Failed to load project configuration.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProject();
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
      newTextLayerName: 'Text'
    });
  }, [project]);

  const validateForm = () => {
    if (formData.textLayerType === 'existing' && !formData.selectedTextLayerId) {
      return 'Select a text layer or choose to create a new one.';
    }
    if (formData.textLayerType === 'new' && !formData.newTextLayerName.trim()) {
      return 'Provide a name for the new text layer.';
    }
    return '';
  };

  // Find an existing UD-flagged child layer (idempotent re-configuration), else null.
  const findFlagged = (layers, namespace, key) =>
    (layers || []).find(layer => layer.config?.[namespace]?.[key] === true) || null;

  const ensureTokenLayer = async (client, textLayerId, existingTextLayer, configKey, name, overlapMode, parentId) => {
    const existing = findFlagged(existingTextLayer?.tokenLayers, UD_NAMESPACE, configKey);
    if (existing) return existing;
    const created = await client.tokenLayers.create(textLayerId, name, overlapMode, parentId);
    await client.tokenLayers.setConfig(created.id, UD_NAMESPACE, configKey, true);
    return created;
  };

  const ensureSpanLayer = async (client, morphemeLayerId, existingMorphemeLayer, configKey, name) => {
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
      let existingTextLayer = availableTextLayers.find(l => l.id === textLayerId) || null;
      if (formData.textLayerType === 'new') {
        const name = formData.newTextLayerName.trim() || 'Text';
        const textLayer = await client.textLayers.create(projectId, name);
        textLayerId = textLayer.id;
        existingTextLayer = null;
      }
      await client.textLayers.setConfig(textLayerId, UD_NAMESPACE, UD_TEXT_CONFIG_KEY, true);

      // 2. Token-layer hierarchy: sentences (partitioning) > words (non-overlapping) > morphemes (any)
      const sentenceLayer = await ensureTokenLayer(
        client, textLayerId, existingTextLayer,
        UD_TOKEN_CONFIG_KEYS.sentence, 'Sentences', 'partitioning', undefined
      );
      const wordLayer = await ensureTokenLayer(
        client, textLayerId, existingTextLayer,
        UD_TOKEN_CONFIG_KEYS.word, 'Words', 'non-overlapping', sentenceLayer.id
      );
      const morphemeLayer = await ensureTokenLayer(
        client, textLayerId, existingTextLayer,
        UD_TOKEN_CONFIG_KEYS.morpheme, 'Morphemes', 'any', wordLayer.id
      );

      // 3. Annotation span layers, all under the morpheme layer
      const existingMorphemeLayer = findFlagged(existingTextLayer?.tokenLayers, UD_NAMESPACE, UD_TOKEN_CONFIG_KEYS.morpheme);
      const spanLayers = {};
      for (const key of SPAN_KEYS_IN_ORDER) {
        spanLayers[key] = await ensureSpanLayer(
          client, morphemeLayer.id, existingMorphemeLayer, UD_SPAN_CONFIG_KEYS[key], SPAN_LAYER_NAMES[key]
        );
      }

      // 4. Dependency relation layer under the lemma span layer
      const existingRelationLayer = findFlagged(spanLayers.lemma?.relationLayers, UD_NAMESPACE, UD_RELATION_CONFIG_KEY);
      if (!existingRelationLayer) {
        const relationLayer = await client.relationLayers.create(spanLayers.lemma.id, 'Dependency Relations');
        await client.relationLayers.setConfig(relationLayer.id, UD_NAMESPACE, UD_RELATION_CONFIG_KEY, true);
      }

      notifySuccess('UD layer configuration saved successfully.');
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
    return <Center py={48}><Loader /></Center>;
  }

  if (!project || !canConfigure) {
    return null;
  }

  const info = getUdLayerInfo(project);
  const missingLabels = info.missingLayers?.length
    ? info.missingLayers.map(key => UD_LAYER_LABELS[key] || key).join(', ')
    : '';

  const statusLine = info.isConfigured ? (
    <Text size="sm" c="green">All Universal Dependencies layers are configured.</Text>
  ) : (
    missingLabels && <Text size="sm" c="orange">Missing configuration detected for: {missingLabels}</Text>
  );

  const content = (
    <>
      {embedded ? (
        statusLine && <div style={{ marginBottom: 'var(--mantine-spacing-md)' }}>{statusLine}</div>
      ) : (
        <Group justify="space-between" align="flex-start" mb="lg">
          <div>
            <Title order={1}>Configure UD Layers</Title>
            <Text c="dimmed" mt={4}>Project: {project.name}</Text>
            <div style={{ marginTop: 'var(--mantine-spacing-xs)' }}>{statusLine}</div>
          </div>
          <Button component={Link} to={`/projects/${projectId}/documents`} variant="default">
            Back to Documents
          </Button>
        </Group>
      )}

      <form onSubmit={handleSubmit}>
        <Stack gap="xl">
          <Paper withBorder p="lg" radius="md">
            <Title order={2} size="h4" mb="md">Text Layer</Title>
            <Stack gap="md">
              <Radio.Group
                value={formData.textLayerType}
                onChange={(value) => setFormData(prev => ({ ...prev, textLayerType: value }))}
              >
                <Group gap="lg">
                  <Radio value="existing" label="Use existing" disabled={availableTextLayers.length === 0} />
                  <Radio value="new" label="Create new" />
                </Group>
              </Radio.Group>

              {formData.textLayerType === 'existing' ? (
                <Select
                  label="Select text layer"
                  placeholder="Select a text layer"
                  value={formData.selectedTextLayerId || null}
                  onChange={(value) => setFormData(prev => ({ ...prev, selectedTextLayerId: value || '' }))}
                  data={availableTextLayers.map(layer => ({ value: layer.id, label: `${layer.name} (${layer.id})` }))}
                />
              ) : (
                <TextInput
                  label="New text layer name"
                  name="newTextLayerName"
                  value={formData.newTextLayerName}
                  onChange={(e) => setFormData(prev => ({ ...prev, newTextLayerName: e.target.value }))}
                  placeholder="e.g. Text"
                />
              )}
            </Stack>
          </Paper>

          <Paper withBorder p="lg" radius="md">
            <Title order={2} size="h4" mb="xs">Token Hierarchy &amp; Annotations</Title>
            <Text size="sm" c="dimmed" mb="md">
              Saving creates (or completes) the three-layer token hierarchy and the annotation layers below.
              Existing UD-flagged layers are reused, so this is safe to re-run.
            </Text>
            <List size="sm" spacing={4}>
              <List.Item><Text span fw={500}>Sentences</Text> token layer (partitioning)</List.Item>
              <List.Item><Text span fw={500}>Words</Text> token layer (non-overlapping, nested in sentences)</List.Item>
              <List.Item><Text span fw={500}>Morphemes</Text> token layer (overlap allowed, nested in words)</List.Item>
              <List.Item>Span layers on morphemes: Form, Lemma, UPOS, XPOS, Features</List.Item>
              <List.Item>Dependency relation layer on the Lemma layer</List.Item>
            </List>
          </Paper>

          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={() => navigate(-1)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" color="dark" loading={saving}>
              Save Configuration
            </Button>
          </Group>
        </Stack>
      </form>
    </>
  );

  return embedded ? content : <Container size="lg" py="xl">{content}</Container>;
};
