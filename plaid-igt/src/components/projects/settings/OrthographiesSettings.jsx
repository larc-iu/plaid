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
  orthographyKey,
} from '@/domain/igtConfig';
import { TYPE } from '@ui/lib/typeScale.js';

// The project is the page's, and a save or a refusal reads the page's project
// again (onProjectUpdate), so every section shows the same one.
export const OrthographiesSettings = ({ project, client, onProjectUpdate }) => {
  const [, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  // Word token layer id, for usage counts at delete time (set during load).
  const wordLayerIdRef = useRef(null);
  // The stored list as last read, which every write expects, so a page opened
  // before another maintainer's save is refused rather than writing over it.
  // A refused save reads the project again and loads the list from it (a new
  // `reloads` remounts the editor).
  const [stored, setStored] = useState(undefined);
  const orthographiesCell = useConfigCell(stored);
  const [reloads, setReloads] = useState(0);

  // The list as the page's project holds it.
  const handleLoadData = async () => {
    try {
      setIsLoading(true);
      setHasError(false);

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
        // Config has been set, respect it even if empty. The stored list
        // never holds the Baseline (the text itself): every stored row is an
        // orthography, whatever it is called, and the Baseline row goes first.
        return {
          orthographies: [
            { name: 'Baseline', isBaseline: true },
            ...(currentConfig || []).map((orth) => ({ name: orth.name, isBaseline: false })),
          ],
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
      // The save has landed, so a read that fails is not a failed save.
      await Promise.resolve(onProjectUpdate?.()).catch((err) =>
        console.error('Failed to reload the project:', err),
      );
    } catch (error) {
      console.error('Failed to save orthographies configuration:', error);
      // Someone else saved since: show what is stored now.
      if (isConfigConflict(error)) {
        await Promise.resolve(onProjectUpdate?.()).catch((err) =>
          console.error('Failed to reload the project:', err),
        );
        setReloads((n) => n + 1);
      } else setHasError(true);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Count words with a non-empty value for this orthography (stored as the
  // orthography key, orthographyKey in igtConfig). null = unknown — the delete dialog
  // warns accordingly. `.` regex = "has at least one character".
  const handleCountOrthographyUsage = async (orthographyName) => {
    const layerId = wordLayerIdRef.current;
    if (!layerId) return null;
    const res = await client.query({
      where: [
        [
          'token',
          '?t',
          { layer: layerId, metadata: { [orthographyKey(orthographyName)]: { regex: '.' } } },
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
      <h2 className={TYPE.card}>Orthographies</h2>
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
