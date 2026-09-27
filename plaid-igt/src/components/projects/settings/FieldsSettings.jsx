import { useMemo, useRef } from 'react';
import { FieldsManager } from './FieldsManager';
import { fieldKey } from '@/domain/fieldNames';
import { notifyError } from '@/utils/feedback';
import {
  findBaselineTextLayer,
  findWordTokenLayer,
  findSentenceTokenLayer,
  findMorphemeTokenLayer,
  readScope,
  readIgnoredTokens,
  ignoredTokensSetup,
  storedIgnoredTokens,
  IGT_NAMESPACE,
} from '@/domain/igtConfig';
import { readTagsetName } from '@/domain/tagsets';
import { readFieldLang, readLanguages } from '@/domain/igtConfig';
import { notSetUp } from '@/domain/setupGuard.js';

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
    lang: readFieldLang(spanLayer.config),
  }));
  if (fields.length === 0 && !ignoredTokensConfig) return null;

  const ignoredTokens = ignoredTokensConfig ? ignoredTokensSetup(ignoredTokensConfig) : null;
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
  // The tags the project's languages record, offered beside each field's own.
  const knownLangs = useMemo(() => {
    const l = readLanguages(project?.config);
    return [
      ...new Set([l.object.tag, l.object.iso639P3, l.meta.tag, l.meta.iso639P3].filter(Boolean)),
    ];
  }, [project?.config]);

  // Read off the LIVE project rather than fetched once on mount, so the table
  // re-syncs whenever the project changes under it. The case that matters:
  // renaming a tagset in the section above repoints these fields on the
  // server, and a table still holding the old name wrote it straight back on
  // its next save, undoing the rename.
  const initialData = useMemo(() => extractFields(project), [project]);

  // One save or move at a time, each after the one before has settled. A save
  // reads the layers that exist and creates the missing ones, so two at once
  // (a second field added while the first is on its way) both made the first.
  const turnRef = useRef(Promise.resolve());
  const inTurn = (fn) => {
    const run = turnRef.current.then(fn, fn);
    turnRef.current = run.catch(() => {});
    return run;
  };

  // Save changes to the API. A new field's layer is made first, one request
  // for the layer and one for its scope, since the rest needs its id. Every
  // other write of the save is one batch, so it lands whole or not at all.
  // A refusal is thrown to the manager, which puts the table back, and
  // handleError reads the project again so the table shows what landed.
  const handleSaveChanges = (data) => inTurn(() => saveNow(data));
  const saveNow = async (data) => {
    if (!client) {
      throw new Error('Not authenticated');
    }

    // Fresh from the server: this creates and deletes layers, so it has to
    // see the ones that exist right now, not the ones the last render saw.
    const layers = layersOf(await client.projects.get(projectId));
    if (!layers) {
      throw new Error(notSetUp('No baseline text layer found in project'));
    }
    const { primary, sentence, morpheme, managed } = layers;

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
          notSetUp(`No ${field.scope.toLowerCase()} token layer found for field ${field.name}`),
        );
      }
      const spanLayer = await client.spanLayers.create(parentLayerId, field.name);
      await client.spanLayers.setConfig(spanLayer.id, IGT_NAMESPACE, 'scope', field.scope);
      layerIds.set(fieldKey(field), spanLayer.id);
    }

    await client.batched((b) => queueRest(b, data, layers, layerIds));
    // The Tagsets section above reads which fields point at which tagset off
    // the project, and that is what gates its "Add values used in this
    // project" button. Without this, pointing a field at a tagset here left
    // that button disabled until a page reload. The save has landed by now,
    // so a reload that fails is not a failed save.
    await Promise.resolve(onProjectUpdate?.()).catch((err) =>
      console.error('Failed to reload the project:', err),
    );
  };

  // Everything a save writes once each field has its layer: the ignored
  // tokens, the removed fields' layers, and each field's tagset and language.
  const queueRest = (b, data, { primary, managed }, layerIds) => {
    const currentFields = data.fields || [];
    if (data.ignoredTokens) {
      b.tokenLayers.setConfig(
        primary.id,
        IGT_NAMESPACE,
        'ignoredTokens',
        storedIgnoredTokens(data.ignoredTokens),
      );
    }

    // Delete span layers for removed fields
    for (const existingLayer of managed) {
      const stillExists = currentFields.find(
        (field) => fieldKey(field) === layerKey(existingLayer),
      );
      if (!stillExists) {
        b.spanLayers.delete(existingLayer.id);
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
      if (next) b.spanLayers.setConfig(layerId, IGT_NAMESPACE, 'tagset', next);
      else b.spanLayers.deleteConfig(layerId, IGT_NAMESPACE, 'tagset');
    }
    // And each field's language, the same way: the record the exporters
    // read, written only when it changed.
    const storedLang = new Map(managed.map((l) => [layerKey(l), readFieldLang(l.config)]));
    for (const field of currentFields) {
      const key = fieldKey(field);
      const layerId = layerIds.get(key);
      if (!layerId) continue;
      const next = field.lang || null;
      if (next === (storedLang.get(key) ?? null)) continue;
      if (next) b.spanLayers.setConfig(layerId, IGT_NAMESPACE, 'lang', next);
      else b.spanLayers.deleteConfig(layerId, IGT_NAMESPACE, 'lang');
    }
  };

  // Move a field one place among the fields of its scope. Order lives on the
  // server (span layers have a display order), so this is a shift of the
  // layer, and the table re-syncs from the refreshed project. The arrows
  // used to reorder only the table and nothing else; a reload undid them.
  const handleMoveField = (field, direction) => inTurn(() => moveNow(field, direction));
  const moveNow = async (field, direction) => {
    const layer = (layersOf(project)?.managed || []).find((l) => layerKey(l) === fieldKey(field));
    if (!layer) return;
    await client.spanLayers.shift(layer.id, direction);
    await Promise.resolve(onProjectUpdate?.()).catch((err) =>
      console.error('Failed to reload the project:', err),
    );
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

  // A refused save or move: say why, and read the project again, so the
  // table shows what the server holds rather than what was asked for.
  const handleError = (error) => {
    notifyError(error, 'Not saved');
    Promise.resolve(onProjectUpdate?.()).catch((err) =>
      console.error('Failed to reload the project:', err),
    );
  };

  // The two cards (Annotation Fields + Ignored Tokens) come from the manager
  // itself, so this wrapper adds nothing but a root: no outer card.
  return (
    <div>
      <FieldsManager
        initialData={initialData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        onCountFieldUsage={handleCountFieldUsage}
        onMoveField={handleMoveField}
        tagsetNames={tagsetNames}
        knownLangs={knownLangs}
        violations={violations}
        projectId={projectId}
        showTitle={false}
      />
    </div>
  );
};
