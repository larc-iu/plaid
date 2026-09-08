// Where an ELAN tier's values land when the import writes into a project that
// already exists. Pure, except for createFields.
//
// A fresh-project import derives the whole field inventory from the corpus and
// lets setup create it. A project someone has been working in already HAS
// fields, and the same tier almost always belongs in one of them: a corpus
// exported for FieldWorks names its tiers `A_Translation-gls-nl`, while the
// project that came from the same FieldWorks project calls the field
// `Translation (nl)`. Mapping onto what is there is the common case, and
// creating a field is the exception that has to be asked for, or a project
// grows a second Translation every time someone imports.

import {
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  readOrthographies,
  readScope,
  IGT_NAMESPACE,
} from '../../domain/igtConfig.js';
import { parseFieldName } from '../../domain/fieldNames.js';

/** The annotation scopes a span layer can carry, in the order they are shown. */
export const SCOPES = ['Sentence', 'Word', 'Morpheme'];

/**
 * The fields the project already has: {scope: [{name, id}]}, in layer order.
 * Every scope is present, so a caller can index it without checking.
 */
export function existingFields(project) {
  const out = Object.fromEntries(SCOPES.map((s) => [s, []]));
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  for (const tl of textLayer?.tokenLayers || []) {
    for (const sl of tl.spanLayers || []) {
      const scope = readScope(sl.config);
      // 'Token' is the older spelling of the word scope, and the export layer
      // discovery already treats the two alike.
      const key = scope === 'Token' ? 'Word' : scope;
      if (out[key]) out[key].push({ name: sl.name, id: sl.id });
    }
  }
  return out;
}

// Names read alike when their base names do, ignoring case, spacing and
// punctuation: "Translation (nl)", "translation" and "Translation-nl" all fold
// together. The writing-system tag comes off first, because "Gloss (en)" beside
// "Gloss" is the naming convention working, not a duplicate.
const fold = (name) =>
  parseFieldName(name)
    .base.toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * An existing field in the same scope whose name reads like `name`, or null.
 * An exact match returns null: that is the field itself, not a near-duplicate.
 */
export function similarField(existing, scope, name) {
  const fields = existing?.[scope] || [];
  if (fields.some((f) => f.name === name)) return null;
  const target = fold(name);
  if (!target) return null;
  return fields.find((f) => fold(f.name) === target)?.name ?? null;
}

/**
 * The fields an import would have to create in this project, in build order.
 * `similarTo` names an existing field that reads like it, which is the one
 * signal that a new field is a mistake about to happen.
 *
 * @returns {Array<{name, scope, similarTo: string|null}>}
 */
export function missingFields(project, fields) {
  const existing = existingFields(project);
  const seen = new Set();
  const out = [];
  for (const { name, scope } of fields || []) {
    const key = `${scope}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if ((existing[scope] || []).some((f) => f.name === name)) continue;
    out.push({ name, scope, similarTo: similarField(existing, scope, name) });
  }
  return out;
}

/**
 * Create the span layers for fields the project does not have yet, under the
 * token layer their scope belongs to.
 *
 * Deliberately NOT executeProjectSetup, which rewrites the word layer's
 * orthographies and the project's document-metadata configuration wholesale:
 * against a project that was set up by a different importer, running it would
 * throw away the setup that project already has.
 */
export async function createFields(client, project, fields, onProgress = null) {
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  const tokenLayers = textLayer?.tokenLayers || [];
  const parentFor = {
    Sentence: findSentenceTokenLayer(tokenLayers)?.id,
    Word: findWordTokenLayer(tokenLayers)?.id,
    Morpheme: findMorphemeTokenLayer(tokenLayers)?.id,
  };
  const created = [];
  for (const field of fields) {
    const parentLayerId = parentFor[field.scope];
    if (!parentLayerId) {
      throw new Error(`This project has no ${field.scope.toLowerCase()} layer to add a field to.`);
    }
    onProgress?.(`Adding field ${field.name} (${field.scope})`);
    const layer = await client.spanLayers.create(parentLayerId, field.name);
    await client.spanLayers.setConfig(layer.id, IGT_NAMESPACE, 'scope', field.scope);
    created.push({ ...field, id: layer.id ?? layer });
  }
  return created;
}

/**
 * The orthographies an import would have to add to the project. An orthography
 * is not a layer but a name on the word layer's configuration, and the engine
 * writes its values into token metadata under that name either way: a project
 * that does not list it holds the values without showing them anywhere.
 */
export function missingOrthographies(project, names) {
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  const wordLayer = findWordTokenLayer(textLayer?.tokenLayers || []);
  const have = new Set((readOrthographies(wordLayer?.config) || []).map((o) => o?.name));
  return [...new Set(names || [])].filter((n) => n && !have.has(n));
}

/** Append orthographies to the word layer, keeping the ones already there. */
export async function addOrthographies(client, project, names) {
  const missing = missingOrthographies(project, names);
  if (!missing.length) return [];
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  const wordLayer = findWordTokenLayer(textLayer?.tokenLayers || []);
  if (!wordLayer) throw new Error('This project has no word layer to add an orthography to.');
  const current = readOrthographies(wordLayer.config) || [];
  await client.tokenLayers.setConfig(wordLayer.id, IGT_NAMESPACE, 'orthographies', [
    ...current,
    ...missing.map((name) => ({ name })),
  ]);
  return missing;
}
