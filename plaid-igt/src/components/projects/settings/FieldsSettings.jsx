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
  defaultIgnoredTokensSetup,
  storedIgnoredTokens,
  readTokenizeNewText,
  TOKENIZE_NEW_TEXT_KEY,
  IGT_NAMESPACE,
} from '@/domain/igtConfig';
import { readTagsetName } from '@/domain/tagsets';
import { readFieldLang, readLanguages } from '@/domain/igtConfig';
import { notSetUp } from '@ui/domain/setupGuard.js';
import { fieldChange } from './fieldChange.js';
import { queueFieldDeclarations, tagsetRefusal } from '@/domain/igtConstraints';
import { sameConfig, storedConfig } from '@ui/domain/configCells.js';
import {
  annotatedCounts,
  annotatedWordsQueries,
  newlyIgnoredForms,
  wordFormsQuery,
} from '@/domain/ignoredChange';

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
    const fresh = await client.projects.get(projectId);
    const layers = layersOf(fresh);
    if (!layers) {
      throw new Error(notSetUp('No baseline text layer found in project'));
    }
    const { primary, sentence, morpheme, managed } = layers;

    // What this save changes is the difference between the table before and
    // after the user's edit, never between the table and the server. A page
    // opened before another maintainer added a field does not list it, and
    // diffing against the server deleted that field with its annotations.
    const change = fieldChange(data);
    // (scope, name) -> span layer id, kept current through the creates and
    // deletes below so the tagset sync at the end can find every field.
    const layerIds = new Map(managed.map((l) => [layerKey(l), l.id]));

    // Create a span layer for each field added here that has none yet.
    for (const field of change.added) {
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

    await client.batched((b) => queueRest(b, data, change, layers, layerIds, fresh?.config));
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
  // tokens, the removed fields' layers, and each field's tagset and language,
  // each only when the user changed it on this page. A value someone else
  // changed since the page read it refuses the save (409), and so does the
  // server when it changes between this read and the write.
  const queueRest = (b, data, change, { primary, managed }, layerIds, projectConfig) => {
    const changedElsewhere = () => Object.assign(new Error('Changed elsewhere'), { status: 409 });
    const shown = new Map(data.previous.fields.map((f) => [fieldKey(f), f]));
    const layerOf = new Map(managed.map((l) => [layerKey(l), l]));

    if (change.ignoredTokens) {
      const raw = storedConfig(primary, IGT_NAMESPACE, 'ignoredTokens');
      const stored = storedIgnoredTokens(
        raw ? ignoredTokensSetup(raw) : defaultIgnoredTokensSetup(),
      );
      const next = storedIgnoredTokens(data.ignoredTokens);
      if (!sameConfig(stored, next)) {
        if (!sameConfig(stored, storedIgnoredTokens(data.previous.ignoredTokens))) {
          throw changedElsewhere();
        }
        b.tokenLayers.setConfig(primary.id, IGT_NAMESPACE, 'ignoredTokens', next, undefined, {
          expected: raw,
        });
      }
    }

    // Delete the span layers of the fields removed here. A layer this page
    // never listed is someone else's and stays.
    for (const field of change.removed) {
      const key = fieldKey(field);
      const layerId = layerIds.get(key);
      if (!layerId) continue;
      b.spanLayers.delete(layerId);
      layerIds.delete(key);
    }

    // Each field's tagset reference and language, for the fields whose value
    // the user changed here. A field stores the tagset's NAME, never a copy of
    // the list, so pointing two fields at one tagset is what makes them share
    // it. The language is the record the exporters read.
    const sync = (fields, cell, read, valueOf, write) => {
      for (const field of fields) {
        const key = fieldKey(field);
        const layerId = layerIds.get(key);
        // A field this page showed and someone else removed since.
        if (!layerId) throw changedElsewhere();
        const next = valueOf(field);
        // A layer created a moment ago has nothing stored yet.
        const layer = layerOf.get(key);
        const stored = layer ? read(layer.config) : null;
        if (next === stored) continue;
        const was = shown.has(key) ? valueOf(shown.get(key)) : null;
        if (stored !== was) throw changedElsewhere();
        write(layerId, next, { expected: storedConfig(layer, IGT_NAMESPACE, cell) });
      }
    };
    sync(
      change.tagset,
      'tagset',
      readTagsetName,
      (f) => f.tagset ?? null,
      (id, next, options) =>
        next
          ? b.spanLayers.setConfig(id, IGT_NAMESPACE, 'tagset', next, undefined, options)
          : b.spanLayers.deleteConfig(id, IGT_NAMESPACE, 'tagset', undefined, options),
    );
    sync(
      change.lang,
      'lang',
      readFieldLang,
      (f) => f.lang || null,
      (id, next, options) =>
        next
          ? b.spanLayers.setConfig(id, IGT_NAMESPACE, 'lang', next, undefined, options)
          : b.spanLayers.deleteConfig(id, IGT_NAMESPACE, 'lang', undefined, options),
    );

    // The rules of each field whose tagset this save sets, a new field's
    // included: one annotation per token, and a closed tagset's list. In the
    // same batch, so a tagset the stored values break is refused with them.
    queueFieldDeclarations(
      b,
      change.tagset.map((field) => {
        const key = fieldKey(field);
        const layer = layerOf.get(key);
        const igt = { ...layer?.config?.[IGT_NAMESPACE], scope: field.scope };
        if (field.tagset) igt.tagset = field.tagset;
        else delete igt.tagset;
        return {
          id: layerIds.get(key),
          config: { ...layer?.config, [IGT_NAMESPACE]: igt },
          // A new field's layer holds nothing to repair.
          constraints: layer ? (layer.constraints ?? {}) : null,
        };
      }),
      projectConfig,
    );
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

  // How many words with values a change of the ignored-tokens rule hides
  // (`before` and `after` in the shape the manager edits), in two reads
  // (domain/ignoredChange.js): the project's word forms, read once and kept
  // for a minute, then the annotated words of only the forms the change newly
  // ignores. A form's count is kept with the forms, so typing a list asks
  // about each new entry once.
  const formsRef = useRef(null);
  const handleCountHiddenWords = async (before, after) => {
    const layers = layersOf(project);
    if (!layers) return 0;
    if (!formsRef.current || Date.now() - formsRef.current.at > 60_000) {
      const read = client.query(wordFormsQuery(layers.primary.id)).then((r) => r?.results || []);
      const entry = { at: Date.now(), read, counts: new Map() };
      formsRef.current = entry;
      read.catch(() => {
        if (formsRef.current === entry) formsRef.current = null;
      });
    }
    const entry = formsRef.current;
    const forms = newlyIgnoredForms(
      await entry.read,
      storedIgnoredTokens(before),
      storedIgnoredTokens(after),
    );
    const unknown = forms.filter((f) => !entry.counts.has(f));
    if (unknown.length) {
      const ids = (layer) =>
        (layer?.spanLayers || []).filter((l) => readScope(l.config)).map((l) => l.id);
      const queries = annotatedWordsQueries(
        {
          wordLayerId: layers.primary.id,
          morphLayerId: layers.morpheme?.id ?? null,
          wordSpanLayerIds: ids(layers.primary),
          morphSpanLayerIds: ids(layers.morpheme),
        },
        unknown,
      );
      const results = [];
      for (const q of queries) results.push((await client.query(q))?.results || []);
      for (const [form, n] of annotatedCounts(unknown, results)) entry.counts.set(form, n);
    }
    return forms.reduce((n, f) => n + (entry.counts.get(f) ?? 0), 0);
  };

  // "Tokenize new text" on the word layer, written over what this page read,
  // so a change saved elsewhere since is refused (409) rather than written
  // over.
  const tokenizeNewText = readTokenizeNewText(layersOf(project)?.primary?.config);
  const handleTokenizeNewTextChange = (next) =>
    inTurn(async () => {
      const primary = layersOf(project)?.primary;
      if (!primary) throw new Error(notSetUp('No baseline text layer found in project'));
      await client.tokenLayers.setConfig(
        primary.id,
        IGT_NAMESPACE,
        TOKENIZE_NEW_TEXT_KEY,
        next,
        undefined,
        { expected: storedConfig(primary, IGT_NAMESPACE, TOKENIZE_NEW_TEXT_KEY) },
      );
      await Promise.resolve(onProjectUpdate?.()).catch((err) =>
        console.error('Failed to reload the project:', err),
      );
    });

  // A refused save or move: say why, and read the project again, so the
  // table shows what the server holds rather than what was asked for.
  const handleError = (error) => {
    notifyError(tagsetRefusal(error) ?? error, 'Not saved');
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
        onCountHiddenWords={handleCountHiddenWords}
        onMoveField={handleMoveField}
        tagsetNames={tagsetNames}
        knownLangs={knownLangs}
        violations={violations}
        projectId={projectId}
        showTitle={false}
        tokenizeNewText={tokenizeNewText}
        onTokenizeNewTextChange={handleTokenizeNewTextChange}
      />
    </div>
  );
};
