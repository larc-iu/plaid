import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { OrthographiesManager } from './OrthographiesManager.jsx';
import { notifySuccess, notifyError } from '@/utils/feedback';

export const OrthographiesSettings = ({ projectId, client }) => {
  const [, setIsLoading] = useState(false);
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

      if (!client) {
        throw new Error('Not authenticated');
      }

      // Get the project which contains text layers
      const project = await client.projects.get(projectId);

      if (!project.textLayers || project.textLayers.length === 0) {
        // No text layers yet, return null for defaults
        return null;
      }

      // Find the text layer that has plaid configuration
      const textLayer = project.textLayers.find(layer => layer.config?.plaid);
      if (!textLayer) {
        // No plaid-configured text layer found, return null for defaults
        return null;
      }

      if (!textLayer.tokenLayers || textLayer.tokenLayers.length === 0) {
        // No token layers yet, return null for defaults
        return null;
      }

      // Get the first token layer (assuming main token layer)
      const tokenLayer = textLayer.tokenLayers[0];

      // Extract current orthographies configuration
      const currentConfig = tokenLayer.config?.plaid?.orthographies;

      // Check if orthographies config has been explicitly set (even if empty)
      const hasOrthographiesConfig = tokenLayer.config?.plaid && Object.prototype.hasOwnProperty.call(tokenLayer.config.plaid, 'orthographies');

      if (hasOrthographiesConfig) {
        // Config has been set, respect it even if empty
        const configOrthographies = (currentConfig || []).map(orth => ({
          name: orth.name,
          isBaseline: orth.name === 'Baseline',
          isCustom: !isPredefinedOrthography(orth.name)
        }));

        // Always ensure baseline is included (it's always present but not stored in config)
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

      // No orthographies config has been set yet, use defaults
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

      if (!client) {
        throw new Error('Not authenticated');
      }

      // Get the project which contains text layers
      const project = await client.projects.get(projectId);

      if (!project.textLayers || project.textLayers.length === 0) {
        throw new Error('No text layers found in project');
      }

      // Find the text layer that has plaid configuration
      const textLayer = project.textLayers.find(layer => layer.config?.plaid);
      if (!textLayer) {
        throw new Error('No plaid-configured text layer found in project');
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

      await client.tokenLayers.setConfig(tokenLayerId, "plaid", "orthographies", nonBaselineOrthographies);

      notifySuccess('Orthographies configuration has been updated', 'Settings Saved');
    } catch (error) {
      console.error('Failed to save orthographies configuration:', error);
      setHasError(true);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Handle errors
  const handleError = () => {
    setHasError(true);
    notifyError('Failed to update orthographies configuration', 'Configuration Error');
  };

  if (hasError) {
    return (
      <div className="tw rounded-lg border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">Configuration Error</p>
            <p className="text-sm text-muted-foreground">
              Failed to load or save orthographies configuration. Please refresh the page and try again.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tw rounded-lg border bg-card p-4">
      <p className="text-lg font-medium">Orthographies</p>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Configure orthographic representations for your project. The Baseline orthography represents your
        token layer and cannot be removed. You can add additional orthographies like IPA, alternative
        writing systems, or normalized forms.
      </p>

      <OrthographiesManager
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        showTitle={false}
      />
    </div>
  );
};
