import { useState } from 'react';
import { Modal, TextInput, Button, Group, Stack, Alert, Paper, Text, List } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';
import {
  UD_NAMESPACE,
  UD_TEXT_CONFIG_KEY,
  UD_TOKEN_CONFIG_KEYS,
  UD_SPAN_CONFIG_KEYS,
  UD_RELATION_CONFIG_KEY
} from '../../utils/udLayerUtils.js';

export const ProjectForm = ({ isOpen, onClose, onSuccess }) => {
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  // Bootstrap a UD project as a sequence of atomic batches. Each batch is
  // server-side atomic (full rollback on any op failure), so a partial-failure
  // state is limited to "everything in batches 1..k-1 was committed, batch k
  // failed". The catch handler attempts to delete the project to roll back the
  // committed prefix, since layers are immutable and a half-configured project
  // is otherwise permanently broken.
  //
  // Why so many batches: an op cannot reference an id produced earlier in the
  // SAME batch. So each layer's `setConfig` (which needs the layer's id) and
  // any child create (which needs the parent's id) must move to the next batch.
  // We pair each setConfig with the next downstream create when possible to
  // minimize round-trips.
  const SPAN_LAYER_SPECS = [
    ['Form', UD_SPAN_CONFIG_KEYS.form],
    ['Lemma', UD_SPAN_CONFIG_KEYS.lemma],
    ['UPOS', UD_SPAN_CONFIG_KEYS.upos],
    ['XPOS', UD_SPAN_CONFIG_KEYS.xpos],
    ['Features', UD_SPAN_CONFIG_KEYS.features]
  ];

  const createProjectWithLayers = async () => {
    const client = getClient();

    // B1: project (alone; textLayer needs project.id)
    const project = await client.projects.create(projectName);
    const projectId = project.id;

    try {
      // B2: textLayer (alone; setConfig + sentence create both need its id)
      client.beginBatch();
      client.textLayers.create(projectId, 'Text');
      const b2 = await client.submitBatch();
      const textLayerId = b2[0].body.id;

      // B3: textLayer.setConfig + sentenceLayer.create
      client.beginBatch();
      client.textLayers.setConfig(textLayerId, UD_NAMESPACE, UD_TEXT_CONFIG_KEY, true);
      client.tokenLayers.create(textLayerId, 'Sentences', 'partitioning');
      const b3 = await client.submitBatch();
      const sentenceLayerId = b3[1].body.id;

      // B4: sentenceLayer.setConfig + wordLayer.create
      client.beginBatch();
      client.tokenLayers.setConfig(sentenceLayerId, UD_NAMESPACE, UD_TOKEN_CONFIG_KEYS.sentence, true);
      client.tokenLayers.create(textLayerId, 'Words', 'non-overlapping', sentenceLayerId);
      const b4 = await client.submitBatch();
      const wordLayerId = b4[1].body.id;

      // B5: wordLayer.setConfig + morphemeLayer.create
      client.beginBatch();
      client.tokenLayers.setConfig(wordLayerId, UD_NAMESPACE, UD_TOKEN_CONFIG_KEYS.word, true);
      client.tokenLayers.create(textLayerId, 'Morphemes', 'any', wordLayerId);
      const b5 = await client.submitBatch();
      const morphemeLayerId = b5[1].body.id;

      // B6: morphemeLayer.setConfig + all 5 span layer creates
      client.beginBatch();
      client.tokenLayers.setConfig(morphemeLayerId, UD_NAMESPACE, UD_TOKEN_CONFIG_KEYS.morpheme, true);
      for (const [name] of SPAN_LAYER_SPECS) {
        client.spanLayers.create(morphemeLayerId, name);
      }
      const b6 = await client.submitBatch();
      // b6: [setConfig, span0, span1, span2, span3, span4]
      const spanLayerIds = SPAN_LAYER_SPECS.map((_, i) => b6[1 + i].body.id);
      const lemmaIdx = SPAN_LAYER_SPECS.findIndex(([, key]) => key === UD_SPAN_CONFIG_KEYS.lemma);
      const lemmaLayerId = spanLayerIds[lemmaIdx];

      // B7: 5x spanLayer.setConfig + relationLayer.create (uses lemmaLayerId)
      client.beginBatch();
      SPAN_LAYER_SPECS.forEach(([, configKey], i) => {
        client.spanLayers.setConfig(spanLayerIds[i], UD_NAMESPACE, configKey, true);
      });
      client.relationLayers.create(lemmaLayerId, 'Dependency Relations');
      const b7 = await client.submitBatch();
      const relationLayerId = b7[b7.length - 1].body.id;

      // B8: relationLayer.setConfig
      client.beginBatch();
      client.relationLayers.setConfig(relationLayerId, UD_NAMESPACE, UD_RELATION_CONFIG_KEY, true);
      await client.submitBatch();

      return project;
    } catch (err) {
      // Best-effort rollback: layers are immutable, so delete the half-created
      // project. If deletion fails too, surface that to the user.
      try {
        await client.projects.delete(projectId);
      } catch (deleteErr) {
        console.error('Failed to roll back partially-created project:', deleteErr);
        const original = err?.message || 'Unknown error';
        const dErr = deleteErr?.message || 'Unknown error';
        const wrapped = new Error(
          `Project bootstrap failed (${original}) AND rollback also failed (${dErr}). ` +
          `Please manually delete project ${projectId}.`
        );
        wrapped.cause = err;
        throw wrapped;
      }
      throw err;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!projectName.trim()) {
      setError('Project name is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await createProjectWithLayers();
      onSuccess();
    } catch (err) {
      console.error('Error creating project:', err);
      setError(err?.message || 'Failed to create project with layers');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={isOpen} onClose={onClose} title="Create New UD Project" size="sm" centered>
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          {error && <Alert color="red">{error}</Alert>}

          <TextInput
            label="Project Name"
            name="projectName"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Enter project name"
            required
            disabled={loading}
            data-autofocus
          />

          <Paper bg="gray.0" p="md" radius="md">
            <Text size="sm" c="dimmed">
              This will create a new project with all necessary layers for Universal Dependencies annotation:
            </Text>
            <List size="sm" spacing={4} mt="xs" c="dimmed">
              <List.Item>Text layer</List.Item>
              <List.Item>Token hierarchy: Sentences &rarr; Words &rarr; Morphemes</List.Item>
              <List.Item>Span layers for: Form, Lemma, UPOS, XPOS, Features</List.Item>
              <List.Item>Relation layer for dependency parsing</List.Item>
            </List>
          </Paper>

          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" color="dark" loading={loading}>
              Create Project
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
};
