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
import {
  UPOS_TAGS, UNIVERSAL_DEPRELS, autoColor, cleanColorMap, baseRel
} from '../../utils/udVocab.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '../../utils/permissions.js';
import {
  Container, Title, Text, Button, Group, Stack, Alert, Paper, Radio, Select, TextInput, List, Center, Loader,
  TagsInput, ColorInput, ActionIcon, Divider, SimpleGrid,
} from '@mantine/core';
import { IconTrash, IconRestore } from '@tabler/icons-react';

// Span layers, in creation order, all attached to the morpheme token layer.
const SPAN_KEYS_IN_ORDER = ['form', 'lemma', 'upos', 'xpos', 'features'];
const SPAN_LAYER_NAMES = {
  form: 'Form',
  lemma: 'Lemma',
  upos: 'UPOS',
  xpos: 'XPOS',
  features: 'Features'
};

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

  // Controlled-vocabulary + color state (seeded from layer config once configured).
  const [uposVocab, setUposVocab] = useState([]);
  const [xposVocab, setXposVocab] = useState([]);
  const [deprelVocab, setDeprelVocab] = useState([]);
  const [deprelColors, setDeprelColors] = useState({}); // { baseRel: '#hex' }
  const [uposColors, setUposColors] = useState({});     // { UPOS: '#hex' }
  const [featureInventory, setFeatureInventory] = useState([]); // [{key, values}]
  const [tokenizerLocale, setTokenizerLocale] = useState(''); // BCP-47, '' = 'und'
  const [savingExtras, setSavingExtras] = useState(false);

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

  // Seed vocab/color editors from the project's current layer config.
  useEffect(() => {
    if (!project) return;
    const info = getUdLayerInfo(project);
    setUposVocab(info.vocab.upos || []);
    setXposVocab(info.vocab.xpos || []);
    setDeprelVocab(info.vocab.deprel || []);
    setDeprelColors(info.colors.deprel || {});
    setUposColors(info.colors.upos || {});
    setFeatureInventory(info.vocab.featureInventory.list.map(e => ({ key: e.key, values: [...e.values] })));
    setTokenizerLocale(info.textLayer?.config?.[UD_NAMESPACE]?.tokenizerLocale || '');
  }, [project]);

  // Set/clear a single color in a {label: '#hex'} map (clearing falls back to auto).
  const setColorIn = (setter) => (key, value) => {
    setter(prev => {
      const next = { ...prev };
      if (value) next[key] = value; else delete next[key];
      return next;
    });
  };

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

      await fetchProject();
      notifySuccess('UD layer configuration saved successfully.');
    } catch (err) {
      console.error('Failed to save configuration:', err);
      notifyError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // Persist vocab lists + color maps + feature inventory. Each setConfig is a
  // PUT (full replace), so this is naturally idempotent and safe to re-run.
  // Colors are a plain {label: '#hex'} map; the client treats `config` as opaque
  // and never re-cases its keys, so labels are safe as object keys (see udVocab.js).
  const handleSaveExtras = async () => {
    setSavingExtras(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const info = getUdLayerInfo(project);

      if (info.textLayer) {
        const loc = tokenizerLocale.trim();
        if (loc) await client.textLayers.setConfig(info.textLayer.id, UD_NAMESPACE, 'tokenizerLocale', loc);
        else await client.textLayers.deleteConfig(info.textLayer.id, UD_NAMESPACE, 'tokenizerLocale');
      }
      if (info.xposLayer) {
        await client.spanLayers.setConfig(info.xposLayer.id, UD_NAMESPACE, 'vocab', xposVocab);
      }
      if (info.relationLayer) {
        await client.relationLayers.setConfig(info.relationLayer.id, UD_NAMESPACE, 'vocab', deprelVocab);
        await client.relationLayers.setConfig(info.relationLayer.id, UD_NAMESPACE, 'colors', cleanColorMap(deprelColors));
      }
      if (info.uposLayer) {
        await client.spanLayers.setConfig(info.uposLayer.id, UD_NAMESPACE, 'vocab', uposVocab);
        await client.spanLayers.setConfig(info.uposLayer.id, UD_NAMESPACE, 'colors', cleanColorMap(uposColors));
      }
      if (info.featuresLayer) {
        const inventory = featureInventory
          .filter(e => e.key.trim())
          .map(e => ({ key: e.key.trim(), values: (e.values || []).map(v => v.trim()).filter(Boolean) }));
        await client.spanLayers.setConfig(info.featuresLayer.id, UD_NAMESPACE, 'inventory', inventory);
      }

      await fetchProject();
      notifySuccess('Vocabulary and colors saved.');
    } catch (err) {
      console.error('Failed to save vocabulary settings:', err);
      notifyError(err.message || 'Failed to save vocabulary settings.');
    } finally {
      setSavingExtras(false);
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

  const Wrapper = ({ children }) =>
    embedded ? <>{children}</> : <Container size="lg" py="xl">{children}</Container>;

  const statusLine = info.isConfigured ? (
    <Text size="sm" c="green">All Universal Dependencies layers are configured.</Text>
  ) : (
    missingLabels && <Text size="sm" c="orange">Missing configuration detected for: {missingLabels}</Text>
  );

  return (
    <Wrapper>
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

      <Stack gap="xl" mt="xl">
        <Divider label="Annotation vocabularies & colors" labelPosition="center" />

        {!info.isConfigured ? (
          <Alert color="gray" variant="light">
            Save the layer configuration above first — vocabulary and color settings attach to the annotation layers.
          </Alert>
        ) : (
          <>
            <Paper withBorder p="lg" radius="md">
              <Title order={2} size="h4" mb="xs">Tokenizer locale</Title>
              <Text size="sm" c="dimmed" mb="md">
                Language tag used for whitespace/word tokenization (<code>Intl.Segmenter</code>). Drives
                script-specific segmentation — especially <code>ja</code>, <code>zh</code>, <code>th</code>, which
                are segmented by dictionary lookup when given the locale. A BCP-47 tag (e.g. <code>en</code>,
                <code> ja</code>, <code>zh-Hans</code>); leave empty for generic (<code>und</code>).
              </Text>
              <TextInput
                value={tokenizerLocale}
                onChange={(e) => setTokenizerLocale(e.target.value)}
                placeholder="und"
                w={220}
              />
            </Paper>

            <Paper withBorder p="lg" radius="md">
              <Group justify="space-between" align="center" mb="xs">
                <Title order={2} size="h4">UPOS tags</Title>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconRestore size={14} />}
                  onClick={() => setUposVocab([...UPOS_TAGS])}
                >
                  Reset to universal 17
                </Button>
              </Group>
              <Text size="sm" c="dimmed" mb="md">
                Universal part-of-speech tags suggested while annotating. Defaults to the 17 universal tags; edit them
                for project-specific needs. Annotators may still type values outside this list.
              </Text>
              <TagsInput
                value={uposVocab}
                onChange={setUposVocab}
                placeholder="Add a UPOS tag and press Enter"
                clearable
              />
            </Paper>

            <Paper withBorder p="lg" radius="md">
              <Title order={2} size="h4" mb="xs">XPOS tags</Title>
              <Text size="sm" c="dimmed" mb="md">
                Language-specific part-of-speech tags suggested while annotating. Annotators may still type values
                outside this list.
              </Text>
              <TagsInput
                value={xposVocab}
                onChange={setXposVocab}
                placeholder="Add an XPOS tag and press Enter"
                clearable
              />
            </Paper>

            <Paper withBorder p="lg" radius="md">
              <Group justify="space-between" align="center" mb="xs">
                <Title order={2} size="h4">Dependency relations</Title>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconRestore size={14} />}
                  onClick={() => setDeprelVocab([...UNIVERSAL_DEPRELS])}
                >
                  Reset to universal 37
                </Button>
              </Group>
              <Text size="sm" c="dimmed" mb="md">
                Relations suggested when labeling edges. Subtypes (e.g. <code>nsubj:pass</code>) are allowed.
              </Text>
              <TagsInput
                value={deprelVocab}
                onChange={setDeprelVocab}
                placeholder="Add a relation and press Enter"
                clearable
              />
            </Paper>

            <Paper withBorder p="lg" radius="md">
              <Title order={2} size="h4" mb="xs">Relation colors</Title>
              <Text size="sm" c="dimmed" mb="md">
                Dependency edges are colored by their base relation. Each shows its current color (an automatic one
                by default); pick a color to override, or clear the field to revert to automatic.
              </Text>
              <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
                {[...new Set(deprelVocab.map(baseRel))].sort().map(rel => (
                  <ColorInput
                    key={rel}
                    label={rel}
                    size="xs"
                    format="hex"
                    value={deprelColors[rel] || autoColor(rel)}
                    onChange={(v) => setColorIn(setDeprelColors)(rel, v)}
                  />
                ))}
              </SimpleGrid>
            </Paper>

            <Paper withBorder p="lg" radius="md">
              <Title order={2} size="h4" mb="xs">UPOS colors</Title>
              <Text size="sm" c="dimmed" mb="md">
                The UPOS tags above, colored in the annotation grid. Each shows its current color; pick one to
                override, or clear the field to revert to automatic.
              </Text>
              <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
                {[...new Set(uposVocab)].map(tag => (
                  <ColorInput
                    key={tag}
                    label={tag}
                    size="xs"
                    format="hex"
                    value={uposColors[tag] || autoColor(tag)}
                    onChange={(v) => setColorIn(setUposColors)(tag, v)}
                  />
                ))}
              </SimpleGrid>
            </Paper>

            <Paper withBorder p="lg" radius="md">
              <Title order={2} size="h4" mb="xs">Feature inventory</Title>
              <Text size="sm" c="dimmed" mb="md">
                Feature names and values offered in the FEATS picker. New keys/values are still allowed while annotating.
              </Text>
              <Stack gap="xs">
                {featureInventory.map((entry, i) => (
                  <Group key={i} align="flex-end" wrap="nowrap" gap="xs">
                    <TextInput
                      label={i === 0 ? 'Feature' : undefined}
                      value={entry.key}
                      w={150}
                      placeholder="e.g. Number"
                      onChange={(e) => setFeatureInventory(prev =>
                        prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                    />
                    <TagsInput
                      label={i === 0 ? 'Values' : undefined}
                      value={entry.values}
                      style={{ flex: 1 }}
                      placeholder="Add a value"
                      onChange={(vals) => setFeatureInventory(prev =>
                        prev.map((x, j) => j === i ? { ...x, values: vals } : x))}
                    />
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      mb={4}
                      aria-label={`Remove ${entry.key || 'feature'}`}
                      onClick={() => setFeatureInventory(prev => prev.filter((_, j) => j !== i))}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                ))}
                <Group>
                  <Button
                    variant="light"
                    size="xs"
                    onClick={() => setFeatureInventory(prev => [...prev, { key: '', values: [] }])}
                  >
                    Add feature
                  </Button>
                </Group>
              </Stack>
            </Paper>

            <Group justify="flex-end">
              <Button color="dark" loading={savingExtras} onClick={handleSaveExtras}>
                Save vocabularies &amp; colors
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Wrapper>
  );
};
