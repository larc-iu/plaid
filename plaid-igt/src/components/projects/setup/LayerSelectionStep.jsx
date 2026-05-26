import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Stack,
  Text,
  Radio,
  Group,
  Select,
  TextInput,
  Paper,
  Alert,
  Loader
} from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';

export const LayerSelectionStep = ({ data, onDataChange, setupData, isNewProject, projectId, user, client }) => {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Extract text layers from project data
  const textLayers = useMemo(() => {
    if (!project) return [];
    return project.textLayers || [];
  }, [project]);

  // Fetch project data on mount
  useEffect(() => {
    const fetchProjectData = async () => {
      try {
        setLoading(true);
        if (!client) throw new Error('Not authenticated');

        const projectData = await client.projects.get(projectId);
        setProject(projectData);
        setError('');
      } catch (err) {
        console.error('Error fetching project:', err);
        setError('Failed to load project data');
      } finally {
        setLoading(false);
      }
    };

    if (projectId) {
      fetchProjectData();
    }
  }, [projectId, client]);

  // Ensure token/morpheme layer types are always 'new' (the only supported option,
  // since overlap-mode and parent-token-layer-id are immutable after creation).
  // Also auto-select text layer when there's exactly one.
  //
  // Runs exactly once per project load (guarded by a ref) so we don't re-fire
  // every time the parent re-renders with a fresh onDataChange identity.
  const didInitDefaultsRef = useRef(false);
  useEffect(() => {
    if (!project || !textLayers) return;
    if (didInitDefaultsRef.current) return;

    const updates = {};
    let needsUpdate = false;

    if (data?.tokenLayerType !== 'new') {
      updates.tokenLayerType = 'new';
      needsUpdate = true;
    }
    if (data?.morphemeLayerType !== 'new') {
      updates.morphemeLayerType = 'new';
      needsUpdate = true;
    }

    // Auto-select text layer if there's exactly one
    if (textLayers.length === 1 && !data?.textLayerType) {
      updates.textLayerType = 'existing';
      updates.selectedTextLayerId = textLayers[0].id;
      needsUpdate = true;
    }

    didInitDefaultsRef.current = true;

    if (needsUpdate) {
      onDataChange({ ...data, ...updates });
    }
  }, [project, textLayers, data, onDataChange]);

  const handleTextLayerTypeChange = (value) => {
    const newData = {
      ...data,
      textLayerType: value,
      selectedTextLayerId: null,
      newTextLayerName: ''
    };
    onDataChange(newData);
  };

  const handleTextLayerSelectionChange = (value) => {
    const newData = {
      ...data,
      selectedTextLayerId: value
    };
    onDataChange(newData);
  };

  const handleNewTextLayerNameChange = (event) => {
    onDataChange({
      ...data,
      newTextLayerName: event.currentTarget.value
    });
  };

  const handleNewTokenLayerNameChange = (event) => {
    onDataChange({
      ...data,
      newTokenLayerName: event.currentTarget.value
    });
  };

  const handleNewMorphemeLayerNameChange = (event) => {
    onDataChange({
      ...data,
      newMorphemeLayerName: event.currentTarget.value
    });
  };

  // Check if we have a valid text layer selection
  const hasValidTextLayerSelection = () => {
    if (data?.textLayerType === 'existing') {
      return !!data?.selectedTextLayerId;
    }
    if (data?.textLayerType === 'new') {
      return !!(data?.newTextLayerName?.trim());
    }
    return false;
  };

  if (loading) {
    return (
      <Stack spacing="lg" align="center">
        <Loader size="md" />
        <Text>Loading project layers...</Text>
      </Stack>
    );
  }

  if (error) {
    return (
      <Alert color="red" title="Error" icon={<IconInfoCircle size={16} />}>
        {error}
      </Alert>
    );
  }

  return (
    <Stack spacing="xl">
      {/* Explanatory header */}
      <div>
        <Text>
          Choose a text layer for Plaid Base to use, then provide names for the new
          token and morpheme layers that will be created.
          <strong> Text layers</strong> contain the baseline text content of your documents.
          <strong> Token layers</strong> define the units for analysis (words and morphemes)
          and serve as the foundation for further annotation layers. Token and morpheme
          layers are always created fresh because their overlap mode and hierarchy are
          fixed at creation time.
        </Text>
      </div>

      {/* Text Layer Selection */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Text Layer</Text>

        <Radio.Group
          value={data?.textLayerType || ''}
          onChange={handleTextLayerTypeChange}
        >
          <Stack spacing="md">
            <Radio
              value="existing"
              label="Use existing text layer"
              disabled={textLayers.filter(layer => layer.id).length === 0}
            />
            {data?.textLayerType === 'existing' && textLayers.filter(layer => layer.id).length > 0 && (
              <Select
                placeholder="Select a text layer"
                data={textLayers
                  .filter(layer => layer.id) // Filter out layers without valid IDs
                  .map(layer => ({
                    value: layer.id,
                    label: layer.name || layer.id
                  }))}
                value={data?.selectedTextLayerId || null}
                onChange={handleTextLayerSelectionChange}
                ml="xl"
              />
            )}
            {data?.textLayerType === 'existing' && textLayers.filter(layer => layer.id).length === 0 && (
              <Text size="sm" c="dimmed" ml="xl">No existing text layers found</Text>
            )}

            <Radio
              value="new"
              label="Create new text layer"
            />
            {data?.textLayerType === 'new' && (
              <TextInput
                placeholder="Enter text layer name"
                value={data?.newTextLayerName || ''}
                onChange={handleNewTextLayerNameChange}
                ml="xl"
              />
            )}
          </Stack>
        </Radio.Group>
      </Paper>

      {/* Token Layer (always new) */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Primary Token Layer</Text>

        {!hasValidTextLayerSelection() ? (
          <Text size="sm" c="dimmed">Please select a text layer first</Text>
        ) : (
          <Stack spacing="xs">
            <Text size="sm" c="dimmed">
              A new primary (word-level) token layer will be created. Name it:
            </Text>
            <TextInput
              placeholder="e.g. Main Tokens"
              value={data?.newTokenLayerName || ''}
              onChange={handleNewTokenLayerNameChange}
            />
          </Stack>
        )}
      </Paper>

      {/* Morpheme Layer (always new) */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Morpheme Token Layer</Text>

        {!hasValidTextLayerSelection() ? (
          <Text size="sm" c="dimmed">Please select a text layer first</Text>
        ) : (
          <Stack spacing="xs">
            <Text size="sm" c="dimmed">
              A new morpheme token layer will be created under the primary token layer. Name it:
            </Text>
            <TextInput
              placeholder="e.g. Main Morphemes"
              value={data?.newMorphemeLayerName || ''}
              onChange={handleNewMorphemeLayerNameChange}
            />
          </Stack>
        )}
      </Paper>
    </Stack>
  );
};

// Validation function for this step
LayerSelectionStep.isValid = (data) => {
  // Must have valid text layer selection
  const hasValidTextLayer =
    (data?.textLayerType === 'existing' && data?.selectedTextLayerId) ||
    (data?.textLayerType === 'new' && data?.newTextLayerName?.trim());

  // Token and morpheme layers are always created new; require non-empty names.
  const hasValidTokenLayer = !!(data?.newTokenLayerName?.trim());
  const hasValidMorphemeLayer = !!(data?.newMorphemeLayerName?.trim());

  return hasValidTextLayer && hasValidTokenLayer && hasValidMorphemeLayer;
};
