import { useState } from 'react';
import { Paper, Text, Alert } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FieldsManager } from './FieldsManager';
import IconAlertTriangle from '@tabler/icons-react/dist/esm/icons/IconAlertTriangle.mjs';

export const FieldsSettings = ({ projectId, client }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Helper to check if a field is predefined
  const isPredefinedField = (fieldName) => {
    const predefinedFields = ['Gloss', 'Translation'];
    return predefinedFields.includes(fieldName);
  };

  // Load current project configuration
  const handleLoadData = async () => {
    try {
      setIsLoading(true);
      setHasError(false);
      
      if (!client) {
        throw new Error('Not authenticated');
      }
      
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
      
      // Extract ignored tokens configuration from token layer
      const ignoredTokensConfig = tokenLayer.config?.flan?.ignoredTokens;
      
      // Extract fields configuration from span layers
      const spanLayers = tokenLayer.spanLayers || [];
      const fieldsWithScope = spanLayers
        .filter(spanLayer => spanLayer.config?.flan?.scope) // Only span layers with flan scope config
        .map(spanLayer => ({
          name: spanLayer.name,
          scope: spanLayer.config.flan.scope,
          isCustom: !isPredefinedField(spanLayer.name)
        }));
      
      if (fieldsWithScope.length === 0 && !ignoredTokensConfig) {
        // No fields or ignored tokens config found, return null for defaults
        return null;
      }
      
      // Convert ignored tokens API format back to component format
      let ignoredTokens = null;
      if (ignoredTokensConfig) {
        if (ignoredTokensConfig.type === 'unicodePunctuation') {
          ignoredTokens = {
            mode: 'unicode-punctuation',
            unicodePunctuationExceptions: ignoredTokensConfig.whitelist || [],
            explicitIgnoredTokens: []
          };
        } else {
          ignoredTokens = {
            mode: 'explicit-list',
            unicodePunctuationExceptions: [],
            explicitIgnoredTokens: ignoredTokensConfig.blacklist || []
          };
        }
      }
      
      return {
        fields: fieldsWithScope,
        ignoredTokens: ignoredTokens
      };
    } catch (error) {
      console.error('Failed to load fields configuration:', error);
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
      
      if (!client) {
        throw new Error('Not authenticated');
      }
      
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
      
      const tokenLayer = textLayer.tokenLayers[0];
      const tokenLayerId = tokenLayer.id;
      
      // Save ignored tokens configuration to token layer
      if (data.ignoredTokens) {
        const ignoredTokensConfig = {
          type: data.ignoredTokens.mode === 'unicode-punctuation' ? 'unicodePunctuation' : 'blacklist'
        };
        
        if (ignoredTokensConfig.type === 'unicodePunctuation') {
          ignoredTokensConfig.whitelist = data.ignoredTokens.unicodePunctuationExceptions || [];
        } else {
          ignoredTokensConfig.blacklist = data.ignoredTokens.explicitIgnoredTokens || [];
        }
        
        await client.tokenLayers.setConfig(tokenLayerId, "flan", "ignoredTokens", ignoredTokensConfig);
      }
      
      // Handle span layers for fields
      const existingSpanLayers = tokenLayer.spanLayers || [];
      const currentFields = data.fields || [];
      
      // Find span layers that have flan scope config (these are managed by us)
      const managedSpanLayers = existingSpanLayers.filter(layer => layer.config?.flan?.scope);
      
      // Create new span layers for new fields
      for (const field of currentFields) {
        const existingLayer = managedSpanLayers.find(layer => layer.name === field.name);
        
        if (!existingLayer) {
          // Create new span layer
          const spanLayer = await client.spanLayers.create(tokenLayerId, field.name);
          await client.spanLayers.setConfig(spanLayer.id, "flan", "scope", field.scope);
        } else {
          // Update existing span layer scope if changed
          if (existingLayer.config.flan.scope !== field.scope) {
            await client.spanLayers.setConfig(existingLayer.id, "flan", "scope", field.scope);
          }
        }
      }
      
      // Delete span layers for removed fields
      for (const existingLayer of managedSpanLayers) {
        const stillExists = currentFields.find(field => field.name === existingLayer.name);
        if (!stillExists) {
          await client.spanLayers.delete(existingLayer.id);
        }
      }
      
      notifications.show({
        title: 'Settings Saved',
        message: 'Annotation fields configuration has been updated',
        color: 'green'
      });
    } catch (error) {
      console.error('Failed to save fields configuration:', error);
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
      message: 'Failed to update fields configuration',
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
            Failed to load or save fields configuration. Please refresh the page and try again.
          </Text>
        </Alert>
      </Paper>
    );
  }

  return (
    <Paper withBorder p="md">
      <Text size="lg" fw={500} mb="md">Annotation Fields</Text>
      <Text size="sm" mb="md" c="dimmed">
        Configure annotation fields for your project. Token scope fields apply to individual words 
        or morphemes, while Sentence scope fields apply to entire sentences or phrases.
      </Text>
      
      <FieldsManager
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        showTitle={false}
      />
    </Paper>
  );
};