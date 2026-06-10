import { useState, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { FieldsManager } from './FieldsManager';
import { notifyError } from '@/utils/feedback';
import {
  findBaselineTextLayer, findWordTokenLayer, findSentenceTokenLayer,
  findMorphemeTokenLayer, readScope, readIgnoredTokens, IGT_NAMESPACE
} from '@/domain/igtConfig';

export const FieldsSettings = ({ projectId, client }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  // field name -> span layer id, for usage counts at delete time. Kept in
  // sync by handleLoadData and by creates/deletes in handleSaveChanges.
  const spanLayerIdsRef = useRef({});

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

      // Find the baseline text layer (the shared substrate).
      const textLayer = findBaselineTextLayer(project.textLayers);
      if (!textLayer) {
        // No baseline text layer found, return null for defaults
        return null;
      }

      // Get the word, sentence, and morpheme token layers by role.
      const primaryTokenLayer = findWordTokenLayer(textLayer.tokenLayers);
      const sentenceTokenLayer = findSentenceTokenLayer(textLayer.tokenLayers);
      const morphemeTokenLayer = findMorphemeTokenLayer(textLayer.tokenLayers);

      if (!primaryTokenLayer) {
        return null;
      }

      // Morpheme layer is now mandatory, so we don't need to set state

      // Extract ignored tokens configuration from primary token layer
      const ignoredTokensConfig = readIgnoredTokens(primaryTokenLayer.config);

      // Extract fields configuration from span layers under all token layers
      const primarySpanLayers = primaryTokenLayer.spanLayers || [];
      const sentenceSpanLayers = sentenceTokenLayer?.spanLayers || [];
      const morphemeSpanLayers = morphemeTokenLayer?.spanLayers || [];
      const allSpanLayers = [...primarySpanLayers, ...sentenceSpanLayers, ...morphemeSpanLayers];

      const scopedSpanLayers = allSpanLayers.filter(spanLayer => readScope(spanLayer.config));
      spanLayerIdsRef.current = Object.fromEntries(scopedSpanLayers.map(l => [l.name, l.id]));

      const fieldsWithScope = scopedSpanLayers
        .map(spanLayer => ({
          name: spanLayer.name,
          scope: readScope(spanLayer.config),
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

      // Find the baseline text layer (the shared substrate).
      const textLayer = findBaselineTextLayer(project.textLayers);
      if (!textLayer) {
        throw new Error('No baseline text layer found in project');
      }

      const primaryTokenLayer = findWordTokenLayer(textLayer.tokenLayers);
      const sentenceTokenLayer = findSentenceTokenLayer(textLayer.tokenLayers);
      const morphemeTokenLayer = findMorphemeTokenLayer(textLayer.tokenLayers);

      if (!primaryTokenLayer) {
        throw new Error('No primary token layer found in project');
      }

      const primaryTokenLayerId = primaryTokenLayer.id;

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

        await client.tokenLayers.setConfig(primaryTokenLayerId, IGT_NAMESPACE, "ignoredTokens", ignoredTokensConfig);
      }

      // Handle span layers for fields (all three scopes — omitting morpheme
      // layers here used to make Morpheme-field deletion a silent no-op).
      const primarySpanLayers = primaryTokenLayer.spanLayers || [];
      const sentenceSpanLayers = sentenceTokenLayer?.spanLayers || [];
      const morphemeSpanLayers = morphemeTokenLayer?.spanLayers || [];
      const existingSpanLayers = [...primarySpanLayers, ...sentenceSpanLayers, ...morphemeSpanLayers];
      const currentFields = data.fields || [];

      // Find span layers that have plaid scope config (these are managed by us)
      const managedSpanLayers = existingSpanLayers.filter(layer => readScope(layer.config));

      // Create new span layers for new fields
      for (const field of currentFields) {
        const existingLayer = managedSpanLayers.find(layer => layer.name === field.name);

        if (!existingLayer) {
          // Choose parent layer based on field scope (Morpheme fields used to
          // be wrongly parented under the word layer, breaking annotation).
          const parentLayerId =
            field.scope === 'Sentence' ? sentenceTokenLayer?.id :
            field.scope === 'Morpheme' ? morphemeTokenLayer?.id :
            primaryTokenLayerId;
          if (!parentLayerId) {
            throw new Error(`No ${field.scope.toLowerCase()} token layer found for field ${field.name}`);
          }

          // Create new span layer
          const spanLayer = await client.spanLayers.create(parentLayerId, field.name);
          await client.spanLayers.setConfig(spanLayer.id, IGT_NAMESPACE, "scope", field.scope);
          spanLayerIdsRef.current[field.name] = spanLayer.id;
        } else {
          // Update existing span layer scope if changed
          if (readScope(existingLayer.config) !== field.scope) {
            await client.spanLayers.setConfig(existingLayer.id, IGT_NAMESPACE, "scope", field.scope);
          }
        }
      }

      // Delete span layers for removed fields
      for (const existingLayer of managedSpanLayers) {
        const stillExists = currentFields.find(field => field.name === existingLayer.name);
        if (!stillExists) {
          await client.spanLayers.delete(existingLayer.id);
          delete spanLayerIdsRef.current[existingLayer.name];
        }
      }
    } catch (error) {
      console.error('Failed to save fields configuration:', error);
      setHasError(true);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Count existing annotations in a field's span layer (one aggregate query).
  // null = unknown — the delete dialog warns accordingly.
  const handleCountFieldUsage = async (field) => {
    const layerId = spanLayerIdsRef.current[field?.name];
    if (!layerId) return 0; // no backing layer yet -> nothing to lose
    const res = await client.query({
      where: [['span', '?s', { layer: layerId }]],
      return: { group: [], aggregates: [['count']] },
    });
    const n = res?.results?.[0]?.[0];
    return typeof n === 'number' ? n : null;
  };

  // Handle errors
  const handleError = (error) => {
    setHasError(true);
    notifyError('Failed to update fields configuration', 'Configuration Error');
  };

  if (hasError) {
    return (
      <div className="tw rounded-lg border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">Configuration Error</p>
            <p className="text-sm text-muted-foreground">
              Failed to load or save fields configuration. Please refresh the page and try again.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // The two cards (Annotation Fields + Ignored Tokens) come from the manager
  // itself, so this wrapper just provides the `.tw` scope — no outer card.
  return (
    <div className="tw">
      <FieldsManager
        onLoadData={handleLoadData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        onCountFieldUsage={handleCountFieldUsage}
        showTitle={false}
      />
    </div>
  );
};
