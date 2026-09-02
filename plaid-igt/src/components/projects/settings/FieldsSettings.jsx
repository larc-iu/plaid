import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { FieldsManager, fieldKey } from './FieldsManager';
import { notifyError } from '@/utils/feedback';
import {
  findBaselineTextLayer,
  findWordTokenLayer,
  findSentenceTokenLayer,
  findMorphemeTokenLayer,
  readScope,
  readIgnoredTokens,
  IGT_NAMESPACE,
} from '@/domain/igtConfig';
import { readTagsetName } from '@/domain/tagsets';

const PREDEFINED = ['Gloss', 'POS', 'Translation', 'Literal Translation', 'Note'];
const isPredefinedField = (fieldName) => PREDEFINED.includes(fieldName);

// A field's identity on a layer: the same (scope, name) pair FieldsManager
// keys on, read off the layer's config.
const layerKey = (layer) => fieldKey({ scope: readScope(layer.config), name: layer.name });

// The token layers the annotation fields hang off, and the span layers under
// them that carry a scope (those are the ones this section manages). Null when
// the project has no baseline yet, which is what the setup wizard is for.
const layersOf = (project) => {
  const textLayer = project?.textLayers?.length ? findBaselineTextLayer(project.textLayers) : null;
  if (!textLayer) return null;
  const primary = findWordTokenLayer(textLayer.tokenLayers);
  if (!primary) return null;
  const sentence = findSentenceTokenLayer(textLayer.tokenLayers);
  const morpheme = findMorphemeTokenLayer(textLayer.tokenLayers);
  // All three scopes — omitting morpheme layers here used to make
  // Morpheme-field deletion a silent no-op.
  const spanLayers = [
    ...(primary.spanLayers || []),
    ...(sentence?.spanLayers || []),
    ...(morpheme?.spanLayers || []),
  ];
  return { primary, sentence, morpheme, managed: spanLayers.filter((l) => readScope(l.config)) };
};

// What FieldsManager shows, read off a project. Null means "use the defaults".
const extractFields = (project) => {
  const layers = layersOf(project);
  if (!layers) return null;
  const ignoredTokensConfig = readIgnoredTokens(layers.primary.config);
  const fields = layers.managed.map((spanLayer) => ({
    name: spanLayer.name,
    scope: readScope(spanLayer.config),
    isCustom: !isPredefinedField(spanLayer.name),
    tagset: readTagsetName(spanLayer.config),
  }));
  if (fields.length === 0 && !ignoredTokensConfig) return null;

  // Convert ignored tokens API format back to component format
  let ignoredTokens = null;
  if (ignoredTokensConfig) {
    if (ignoredTokensConfig.type === 'unicodePunctuation') {
      ignoredTokens = {
        mode: 'unicode-punctuation',
        unicodePunctuationExceptions: ignoredTokensConfig.whitelist || [],
        explicitIgnoredTokens: [],
      };
    } else {
      ignoredTokens = {
        mode: 'explicit-list',
        unicodePunctuationExceptions: [],
        explicitIgnoredTokens: ignoredTokensConfig.blacklist || [],
      };
    }
  }
  return { fields, ignoredTokens };
};

// `project` and `tagsetNames` come from AnnotationSettings, which holds the
// live project, so a tagset created in the section above shows up in the
// picker immediately.
export const FieldsSettings = ({
  project,
  projectId,
  client,
  tagsetNames = [],
  violations = {},
  onProjectUpdate,
}) => {
  const [hasError, setHasError] = useState(false);

  // Read off the LIVE project rather than fetched once on mount, so the table
  // re-syncs whenever the project changes under it. The case that matters:
  // renaming a tagset in the section above repoints these fields on the
  // server, and a table still holding the old name wrote it straight back on
  // its next save, undoing the rename.
  const initialData = useMemo(() => extractFields(project), [project]);

  // Save changes to the API
  const handleSaveChanges = async (data) => {
    try {
      setHasError(false);

      if (!client) {
        throw new Error('Not authenticated');
      }

      // Fresh from the server: this creates and deletes layers, so it has to
      // see the ones that exist right now, not the ones the last render saw.
      const layers = layersOf(await client.projects.get(projectId));
      if (!layers) {
        throw new Error('No baseline text layer found in project');
      }
      const { primary, sentence, morpheme, managed } = layers;

      // Save ignored tokens configuration to token layer
      if (data.ignoredTokens) {
        const ignoredTokensConfig = {
          type:
            data.ignoredTokens.mode === 'unicode-punctuation' ? 'unicodePunctuation' : 'blacklist',
        };

        if (ignoredTokensConfig.type === 'unicodePunctuation') {
          ignoredTokensConfig.whitelist = data.ignoredTokens.unicodePunctuationExceptions || [];
        } else {
          ignoredTokensConfig.blacklist = data.ignoredTokens.explicitIgnoredTokens || [];
        }

        await client.tokenLayers.setConfig(
          primary.id,
          IGT_NAMESPACE,
          'ignoredTokens',
          ignoredTokensConfig,
        );
      }

      const currentFields = data.fields || [];
      // (scope, name) -> span layer id, kept current through the creates and
      // deletes below so the tagset sync at the end can find every field.
      const layerIds = new Map(managed.map((l) => [layerKey(l), l.id]));

      // Create new span layers for new fields (identity = scope + name)
      for (const field of currentFields) {
        if (layerIds.has(fieldKey(field))) continue;
        // Choose parent layer based on field scope (Morpheme fields used to
        // be wrongly parented under the word layer, breaking annotation).
        const parentLayerId =
          field.scope === 'Sentence'
            ? sentence?.id
            : field.scope === 'Morpheme'
              ? morpheme?.id
              : primary.id;
        if (!parentLayerId) {
          throw new Error(
            `No ${field.scope.toLowerCase()} token layer found for field ${field.name}`,
          );
        }
        const spanLayer = await client.spanLayers.create(parentLayerId, field.name);
        await client.spanLayers.setConfig(spanLayer.id, IGT_NAMESPACE, 'scope', field.scope);
        layerIds.set(fieldKey(field), spanLayer.id);
      }

      // Delete span layers for removed fields
      for (const existingLayer of managed) {
        const stillExists = currentFields.find(
          (field) => fieldKey(field) === layerKey(existingLayer),
        );
        if (!stillExists) {
          await client.spanLayers.delete(existingLayer.id);
          layerIds.delete(layerKey(existingLayer));
        }
      }

      // Sync each field's tagset reference. A field stores the tagset's NAME,
      // never a copy of the list, so pointing two fields at one tagset is what
      // makes them share it. Only write when it actually changed: this runs on
      // every save of the section, including ones that only touched a name.
      const storedTagset = new Map(managed.map((l) => [layerKey(l), readTagsetName(l.config)]));
      for (const field of currentFields) {
        const key = fieldKey(field);
        const layerId = layerIds.get(key);
        if (!layerId) continue;
        const next = field.tagset ?? null;
        // A layer created a moment ago has no stored tagset yet.
        if (next === (storedTagset.get(key) ?? null)) continue;
        if (next) await client.spanLayers.setConfig(layerId, IGT_NAMESPACE, 'tagset', next);
        else await client.spanLayers.deleteConfig(layerId, IGT_NAMESPACE, 'tagset');
      }

      // The Tagsets section above reads which fields point at which tagset off
      // the project, and that is what gates its "Add values used in this
      // project" button. Without this, pointing a field at a tagset here left
      // that button disabled until a page reload.
      await onProjectUpdate?.();
    } catch (error) {
      console.error('Failed to save fields configuration:', error);
      setHasError(true);
      throw error;
    }
  };

  // Move a field one place among the fields of its scope. Order lives on the
  // server (span layers have a display order), so this is a shift of the
  // layer, and the table re-syncs from the refreshed project. The arrows
  // used to reorder only the table and nothing else; a reload undid them.
  const handleMoveField = async (field, direction) => {
    const layer = (layersOf(project)?.managed || []).find((l) => layerKey(l) === fieldKey(field));
    if (!layer) return;
    await client.spanLayers.shift(layer.id, direction);
    await onProjectUpdate?.();
  };

  // Count existing annotations in a field's span layer (one aggregate query).
  // null = unknown — the delete dialog warns accordingly.
  const handleCountFieldUsage = async (field) => {
    const layer = field
      ? (layersOf(project)?.managed || []).find((l) => layerKey(l) === fieldKey(field))
      : null;
    if (!layer) return 0; // no backing layer yet -> nothing to lose
    const res = await client.query({
      where: [['span', '?s', { layer: layer.id }]],
      return: { group: [], aggregates: [['count']] },
    });
    const n = res?.results?.[0]?.[0];
    return typeof n === 'number' ? n : null;
  };

  // Handle errors
  const handleError = () => {
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
        initialData={initialData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        onCountFieldUsage={handleCountFieldUsage}
        onMoveField={handleMoveField}
        tagsetNames={tagsetNames}
        violations={violations}
        projectId={projectId}
        showTitle={false}
      />
    </div>
  );
};
