import { useState } from 'react';
import { Paper, Text, Alert } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { OrthographiesManager } from './OrthographiesManager.jsx';
import { IconAlertTriangle } from '@tabler/icons-react';

export const OrthographiesSettings = ({ projectId, getClient }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Helper to check if an orthography is predefined
  const isPredefinedOrthography = (orthographyName) => {
    const predefinedOrthographies = ['Baseline', 'IPA'];
    return predefinedOrthographies.includes(orthographyName);
  };

  // Load current project configuration
  const handleLoadData = async () => {
    try {
      setIsLoading(true);
      setHasError(false);
      
      const client = getClient();
      
      // Get the project which contains text layers
      const project = await client.projects.get(projectId);
      
      if (!project.textLayers || project.textLayers.length === 0) {
        // No text layers yet, return null for defaults
        return null;
      }
      
      // Find the text layer that has flan configuration
      const textLayer = project.textLayers.find(layer => layer.config?.flan);
      if (!textLayer) {
        // No flan-configured text layer found, return null for defaults
        return null;
      }
      
      if (!textLayer.tokenLayers || textLayer.tokenLayers.length === 0) {
        // No token layers yet, return null for defaults
        return null;
      }
      
      // Get the first token layer (assuming main token layer)
      const tokenLayer = textLayer.tokenLayers[0];
      
      // Extract current orthographies configuration
      const currentConfig = tokenLayer.config?.flan?.orthographies;
      
      if (currentConfig && Array.isArray(currentConfig)) {
        // Convert API format back to component format
        // Note: The baseline orthography might not be stored in config, so add it
        const configOrthographies = currentConfig.map(orth => ({
          name: orth.name,
          isBaseline: orth.name === 'Baseline',
          isCustom: !isPredefinedOrthography(orth.name)
        }));
        
        // Ensure baseline is first
        const hasBaseline = configOrthographies.some(orth => orth.isBaseline);
        if (!hasBaseline) {
          configOrthographies.unshift({
            name: 'Baseline',
            isBaseline: true,
            isCustom: false
          });
        }
        
        return {
          orthographies: configOrthographies
        };
      }
      
      // Return null to use default orthographies
      return null;
    } catch (error) {
      console.error('Failed to load orthographies configuration:', error);
      setHasError(true);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Save changes to the API
  const handleSaveChanges = async (data) => {
    try {
      setIsLoading(true);
      setHasError(false);
      
      const client = getClient();
      
      // Get the project which contains text layers
      const project = await client.projects.get(projectId);
      
      if (!project.textLayers || project.textLayers.length === 0) {
        throw new Error('No text layers found in project');
      }
      
      // Find the text layer that has flan configuration
      const textLayer = project.textLayers.find(layer => layer.config?.flan);
      if (!textLayer) {
        throw new Error('No flan-configured text layer found in project');
      }
      
      if (!textLayer.tokenLayers || textLayer.tokenLayers.length === 0) {
        throw new Error('No token layers found in project');
      }
      
      const tokenLayerId = textLayer.tokenLayers[0].id;
      
      // Convert to API format (filter out baseline, only store non-baseline orthographies)
      const nonBaselineOrthographies = data.orthographies
        .filter(orth => !orth.isBaseline)
        .map(orth => ({
          name: orth.name
        }));
      
      await client.tokenLayers.setConfig(tokenLayerId, "flan", "orthographies", nonBaselineOrthographies);
      
      notifications.show({
        title: 'Settings Saved',
        message: 'Orthographies configuration has been updated',
        color: 'green'
      });
    } catch (error) {
      console.error('Failed to save orthographies configuration:', error);
      setHasError(true);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Handle errors
  const handleError = (error) => {
    setHasError(true);
    notifications.show({
      title: 'Configuration Error',
      message: 'Failed to update orthographies configuration',
      color: 'red'
    });
  };

  if (hasError) {
    return (
      <Paper p="md" withBorder>
        <Alert 
          icon={<IconAlertTriangle size={16} />}
          title="Configuration Error" 
          color="red"
          variant="light"
        >
          <Text size="sm">
            Failed to load or save orthographies configuration. Please refresh the page and try again.
          </Text>
        </Alert>
      </Paper>
    );
  }

  return (
    <Paper withBorder p="md">
      <Text size="lg" fw={500} mb="md">Orthographies</Text>
      <Text size="sm" mb="md" c="dimmed">
        Configure orthographic representations for your project. The Baseline orthography represents your 
        token layer and cannot be removed. You can add additional orthographies like IPA, alternative 
        writing systems, or normalized forms.
      </Text>
      
      <OrthographiesManager
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        showTitle={false}
      />
    </Paper>
  );
};