import { useState, useEffect, useMemo } from 'react';
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

  // Extract text layers and token layers from project data
  const { textLayers, tokenLayersByTextLayer } = useMemo(() => {
    if (!project) return { textLayers: [], tokenLayersByTextLayer: {} };
    
    const textLayers = project.textLayers || [];
    const tokenLayersByTextLayer = {};
    
    textLayers.forEach(textLayer => {
      tokenLayersByTextLayer[textLayer.id] = textLayer.tokenLayers || [];
    });
    
    return { textLayers, tokenLayersByTextLayer };
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

  // Auto-select single text layer and single token layer when data loads
  useEffect(() => {
    if (!project || !textLayers) return;

    // Auto-select text layer if there's exactly one
    if (textLayers.length === 1 && !data?.textLayerType) {
      const textLayer = textLayers[0];
      const newData = {
        ...data,
        textLayerType: 'existing',
        selectedTextLayerId: textLayer.id,
        tokenLayerType: null,
        selectedTokenLayerId: null,
        newTokenLayerName: ''
      };
      
      // Auto-select token layer if there's exactly one for this text layer
      const availableTokens = textLayer.tokenLayers || [];
      if (availableTokens.length === 1) {
        newData.tokenLayerType = 'existing';
        newData.selectedTokenLayerId = availableTokens[0].id;
      }
      
      onDataChange(newData);
    }
  }, [project, textLayers, data, onDataChange]);

  const handleTextLayerTypeChange = (value) => {
    const newData = {
      ...data,
      textLayerType: value,
      selectedTextLayerId: null,
      newTextLayerName: '',
      tokenLayerType: null,
      selectedTokenLayerId: null,
      newTokenLayerName: ''
    };
    onDataChange(newData);
  };

  const handleTextLayerSelectionChange = (value) => {
    const newData = {
      ...data,
      selectedTextLayerId: value,
      tokenLayerType: null,
      selectedTokenLayerId: null,
      newTokenLayerName: ''
    };
    onDataChange(newData);
  };

  const handleNewTextLayerNameChange = (event) => {
    onDataChange({
      ...data,
      newTextLayerName: event.currentTarget.value
    });
  };

  const handleTokenLayerTypeChange = (value) => {
    const newData = {
      ...data,
      tokenLayerType: value,
      selectedTokenLayerId: null,
      newTokenLayerName: ''
    };
    onDataChange(newData);
  };

  const handleTokenLayerSelectionChange = (value) => {
    onDataChange({
      ...data,
      selectedTokenLayerId: value
    });
  };

  const handleNewTokenLayerNameChange = (event) => {
    onDataChange({
      ...data,
      newTokenLayerName: event.currentTarget.value
    });
  };

  // Get available token layers for the selected text layer
  const availableTokenLayers = useMemo(() => {
    if (!data?.selectedTextLayerId) return [];
    return tokenLayersByTextLayer[data.selectedTextLayerId] || [];
  }, [tokenLayersByTextLayer, data?.selectedTextLayerId]);

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
          Choose a text layer and a token layer for Plaid Base to use.
          <strong> Text layers</strong> contain the baseline text content of your documents.
          <strong> Token layers</strong> define the units for analysis (typically morphemes, words, or other linguistic units)
          and serve as the foundation for further annotation layers.
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

      {/* Token Layer Selection */}
      <Paper p="md" withBorder>
        <Text size="md" fw={500} mb="md">Token Layer</Text>
        
        {!hasValidTextLayerSelection() ? (
          <Text size="sm" c="dimmed">Please select a text layer first</Text>
        ) : (
          <Radio.Group
            value={data?.tokenLayerType || ''}
            onChange={handleTokenLayerTypeChange}
          >
            <Stack spacing="md">
              <Radio
                value="existing"
                label="Use existing token layer"
                disabled={availableTokenLayers.filter(layer => layer.id).length === 0}
              />
              {data?.tokenLayerType === 'existing' && availableTokenLayers.filter(layer => layer.id).length > 0 && (
                <Select
                  placeholder="Select a token layer"
                  data={availableTokenLayers
                    .filter(layer => layer.id) // Filter out layers without valid IDs
                    .map(layer => ({
                      value: layer.id,
                      label: layer.name || layer.id
                    }))}
                  value={data?.selectedTokenLayerId || null}
                  onChange={handleTokenLayerSelectionChange}
                  ml="xl"
                />
              )}
              {data?.tokenLayerType === 'existing' && availableTokenLayers.filter(layer => layer.id).length === 0 && (
                <Text size="sm" c="dimmed" ml="xl">
                  No existing token layers found for the selected text layer
                </Text>
              )}
              
              <Radio
                value="new"
                label="Create new token layer"
              />
              {data?.tokenLayerType === 'new' && (
                <TextInput
                  placeholder="Enter token layer name"
                  value={data?.newTokenLayerName || ''}
                  onChange={handleNewTokenLayerNameChange}
                  ml="xl"
                />
              )}
            </Stack>
          </Radio.Group>
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
  
  // Must have valid token layer selection
  const hasValidTokenLayer = 
    (data?.tokenLayerType === 'existing' && data?.selectedTokenLayerId) ||
    (data?.tokenLayerType === 'new' && data?.newTokenLayerName?.trim());
  
  return hasValidTextLayer && hasValidTokenLayer;
};