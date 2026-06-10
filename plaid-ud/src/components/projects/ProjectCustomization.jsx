import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { UD_NAMESPACE, getUdLayerInfo } from '../../utils/udLayerUtils.js';
import {
  UPOS_TAGS, UNIVERSAL_DEPRELS, autoColor, cleanColorMap, baseRel
} from '../../utils/udVocab.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { useManagedProject } from './useManagedProject.js';
import {
  Container, Title, Text, Button, Group, Stack, Alert, Paper, TextInput, Center, Loader,
  TagsInput, ColorInput, ActionIcon, SimpleGrid,
} from '@mantine/core';
import { IconTrash, IconRestore } from '@tabler/icons-react';

// "UD Customization" tab: project-specific controlled vocabularies, colors, and
// the feature inventory. Everything here is local state until you press Save —
// nothing round-trips on a keystroke. These settings attach to the UD annotation
// layers, so the project must be configured before they can be edited. (The
// tokenizer locale and project deletion live on the General tab.)
export const ProjectCustomization = ({ embedded = false }) => {
  const { project, loading, fetchProject, canConfigure } = useManagedProject();
  const { getClient } = useAuth();

  const [saving, setSaving] = useState(false);

  const [uposVocab, setUposVocab] = useState([]);
  const [xposVocab, setXposVocab] = useState([]);
  const [deprelVocab, setDeprelVocab] = useState([]);
  const [deprelColors, setDeprelColors] = useState({}); // { baseRel: '#hex' }
  const [uposColors, setUposColors] = useState({});     // { UPOS: '#hex' }
  const [featureInventory, setFeatureInventory] = useState([]); // [{key, values}]

  // Seed the editors from the project's current layer config.
  useEffect(() => {
    if (!project) return;
    const info = getUdLayerInfo(project);
    setUposVocab(info.vocab.upos || []);
    setXposVocab(info.vocab.xpos || []);
    setDeprelVocab(info.vocab.deprel || []);
    setDeprelColors(info.colors.deprel || {});
    setUposColors(info.colors.upos || {});
    setFeatureInventory(info.vocab.featureInventory.list.map(e => ({ key: e.key, values: [...e.values] })));
  }, [project]);

  // Set/clear a single color in a {label: '#hex'} map (clearing falls back to auto).
  const setColorIn = (setter) => (key, value) => {
    setter(prev => {
      const next = { ...prev };
      if (value) next[key] = value; else delete next[key];
      return next;
    });
  };

  // Persist everything on this tab in one go. Each setConfig is a PUT (full
  // replace), so this is idempotent and safe to re-run.
  const handleSave = async () => {
    setSaving(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const info = getUdLayerInfo(project);

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
      notifySuccess('Customization saved.');
    } catch (err) {
      console.error('Failed to save customization:', err);
      notifyError(err.message || 'Failed to save customization.');
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

  const content = !info.isConfigured ? (
    <Alert color="gray" variant="light">
      Configure the project's UD layers first — vocabulary and color settings attach to those
      annotation layers.
    </Alert>
  ) : (
    <Stack gap="xl">
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
        <Button color="dark" loading={saving} onClick={handleSave}>
          Save customization
        </Button>
      </Group>
    </Stack>
  );

  return embedded ? content : <Container size="lg" py="xl">{content}</Container>;
};
