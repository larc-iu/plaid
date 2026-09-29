import { useState, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { OrthographiesManager } from './OrthographiesManager.jsx';
import { notifyError } from '@/utils/feedback';
import { isConfigConflict, storedConfig } from '@ui/domain/configCells.js';
import { useConfigCell } from '@ui/hooks/useConfigCell.js';
import { notSetUp } from '@ui/domain/setupGuard.js';
import {
  findBaselineTextLayer,
  findWordTokenLayer,
  readOrthographies,
  IGT_NAMESPACE,
} from '@/domain/igtConfig';

export const OrthographiesSettings = ({ projectId, client }) => {
  const [, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  // Word token layer id, for usage counts at delete time (set during load).
  const wordLayerIdRef = useRef(null);
  // The stored list as last read, which every write expects, so a page opened
  // before another maintainer's save is refused rather than writing over it.
  // A refused save loads the list again (a new `reloads` remounts the editor).
  const [stored, setStored] = useState(undefined);
  const orthographiesCell = useConfigCell(stored);
  const [reloads, setReloads] = useState(0);

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

      // Find the baseline text layer (the shared substrate).
      const textLayer = findBaselineTextLayer(project.textLayers);
      if (!textLayer) {
        // No baseline text layer found, return null for defaults
        return null;
      }

      // The word token layer holds the orthographies config.
      const tokenLayer = findWordTokenLayer(textLayer.tokenLayers);
      if (!tokenLayer) return null;
      wordLayerIdRef.current = tokenLayer.id;
      setStored(storedConfig(tokenLayer, IGT_NAMESPACE, 'orthographies'));

      // Extract current orthographies configuration
      const currentConfig = readOrthographies(tokenLayer.config);

      // Check if orthographies config has been explicitly set (even if empty)
      const hasOrthographiesConfig =
        tokenLayer.config?.[IGT_NAMESPACE] &&
        Object.prototype.hasOwnProperty.call(tokenLayer.config[IGT_NAMESPACE], 'orthographies');

      if (hasOrthographiesConfig) {
        // Config has been set, respect it even if empty
        const configOrthographies = (currentConfig || []).map((orth) => ({
          name: orth.name,
          isBaseline: orth.name === 'Baseline',
          isCustom: !isPredefinedOrthography(orth.name),
        }));

        // Always ensure baseline is included (it's always present but not stored in config)
        const hasBaseline = configOrthographies.some((orth) => orth.isBaseline);
        if (!hasBaseline) {
          configOrthographies.unshift({
            name: 'Baseline',
            isBaseline: true,
            isCustom: false,
          });
        }

        return {
          orthographies: configOrthographies,
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
        throw new Error(notSetUp('No text layers found in project'));
      }

      // Find the baseline text layer (the shared substrate).
      const textLayer = findBaselineTextLayer(project.textLayers);
      if (!textLayer) {
        throw new Error(notSetUp('No baseline text layer found in project'));
      }

      const wordTokenLayer = findWordTokenLayer(textLayer.tokenLayers);
      if (!wordTokenLayer) {
        throw new Error(notSetUp('No word token layer found in project'));
      }
      const tokenLayerId = wordTokenLayer.id;

      // Convert to API format (filter out baseline, only store non-baseline orthographies)
      const nonBaselineOrthographies = data.orthographies
        .filter((orth) => !orth.isBaseline)
        .map((orth) => ({
          name: orth.name,
        }));

      await orthographiesCell.write(async (expected) => {
        await client.tokenLayers.setConfig(
          tokenLayerId,
          IGT_NAMESPACE,
          'orthographies',
          nonBaselineOrthographies,
          undefined,
          { expected },
        );
        return nonBaselineOrthographies;
      });
    } catch (error) {
      console.error('Failed to save orthographies configuration:', error);
      // Someone else saved since: show what is stored now.
      if (isConfigConflict(error)) setReloads((n) => n + 1);
      else setHasError(true);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Count words with a non-empty value for this orthography (stored as the
  // `orthog:<name>` token-metadata key). null = unknown — the delete dialog
  // warns accordingly. `.` regex = "has at least one character".
  const handleCountOrthographyUsage = async (orthographyName) => {
    const layerId = wordLayerIdRef.current;
    if (!layerId) return null;
    const res = await client.query({
      where: [
        [
          'token',
          '?t',
          { layer: layerId, metadata: { [`orthog:${orthographyName}`]: { regex: '.' } } },
        ],
      ],
      return: { group: [], aggregates: [['count']] },
    });
    const n = res?.results?.[0]?.[0];
    return typeof n === 'number' ? n : null;
  };

  // Handle errors
  const handleError = (error) => {
    if (!isConfigConflict(error)) setHasError(true);
    notifyError(error, 'Failed to save the orthographies');
  };

  if (hasError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">
              Failed to load or save the orthographies
            </p>
            <p className="text-sm text-muted-foreground">Refresh the page and try again.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Orthographies</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        The ways this project’s text is written. Baseline cannot be removed. Add others for IPA,
        another writing system, or a normalized form.
      </p>

      <OrthographiesManager
        key={reloads}
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        onCountOrthographyUsage={handleCountOrthographyUsage}
        showTitle={false}
      />
    </div>
  );
};
