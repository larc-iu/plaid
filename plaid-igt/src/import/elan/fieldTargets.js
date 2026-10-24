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
  readLexiconField,
  readScope,
  readVocabFields,
  IGT_NAMESPACE,
} from '../../domain/igtConfig.js';
import { CORE_VOCAB_FIELDS, normalizeVocabFields } from '../../domain/vocabFields.js';
import { parseFieldName } from '../../domain/fieldNames.js';
import { queueNewField } from '../../domain/igtConstraints.js';
import { lexiconFieldChoices, withLexiconFields } from '../../domain/lexiconField.js';

/** The annotation scopes a span layer can carry, in the order they are shown. */
const SCOPES = ['Sentence', 'Word', 'Morpheme'];

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
      if (out[scope]) out[scope].push({ name: sl.name, id: sl.id });
    }
  }
  return out;
}

/**
 * Each field's span layer id by scope and name, `{scope: {name: id}}`: what a
 * project's default service fields are stored by.
 */
export const fieldIdsOf = (project) =>
  Object.fromEntries(
    Object.entries(existingFields(project)).map(([scope, fs]) => [
      scope,
      Object.fromEntries(fs.map((f) => [f.name, f.id])),
    ]),
  );

/** The same, as names only: what a `field` service parameter is chosen from. */
export const fieldNamesOf = (project) =>
  Object.fromEntries(
    Object.entries(existingFields(project)).map(([scope, fs]) => [scope, fs.map((f) => f.name)]),
  );

/**
 * The role each field's stored Lexicon field holds, by scope and name,
 * `{scope: {name: role}}`: what fills a service's `field` parameter that names
 * a role. The role is the one the project's vocabularies declare for that
 * entry field (none when declared without one), else, for a key no vocabulary
 * declares, the one a new vocabulary's core field of that key holds.
 */
export const fieldRolesOf = (project) => {
  const roleOfKey = {};
  for (const f of CORE_VOCAB_FIELDS) if (f.role) roleOfKey[f.name] = f.role;
  // A key a vocabulary declares holds the role it declares, none included: a
  // cleared role is no role. The first vocabulary to declare a key decides.
  const declared = {};
  for (const v of project?.vocabs || []) {
    const raw = readVocabFields(v?.config) || {};
    for (const f of normalizeVocabFields(raw)) {
      if (f.name in raw && !(f.name in declared)) declared[f.name] = f.role;
    }
  }
  Object.assign(roleOfKey, declared);
  const out = {};
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  for (const tl of textLayer?.tokenLayers || []) {
    for (const sl of tl.spanLayers || []) {
      const scope = readScope(sl.config);
      const role = roleOfKey[readLexiconField(sl.config)];
      if (scope && role) (out[scope] ??= {})[sl.name] = role;
    }
  }
  return out;
};

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
  for (const { name, scope, lang } of fields || []) {
    const key = `${scope}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if ((existing[scope] || []).some((f) => f.name === name)) continue;
    out.push({ name, scope, lang: lang ?? null, similarTo: similarField(existing, scope, name) });
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
  // A field's name proposes its Lexicon field among the project's
  // vocabularies' fields, as Settings proposes one for a field it adds.
  const planned = withLexiconFields(fields, lexiconFieldChoices(project?.vocabs)).map((field) => {
    const parentLayerId = parentFor[field.scope];
    if (!parentLayerId) {
      throw new Error(`This project has no ${field.scope.toLowerCase()} layer to add a field to.`);
    }
    return { field, parentLayerId };
  });
  if (!planned.length) return [];
  // One batch: each field's layer with its scope, its language (a tier name
  // says what language it is in, see readFieldLang) and its rules, as Settings
  // makes a field it adds. A new field has no tagset, and no failure leaves a
  // field without its rules.
  onProgress?.(
    fields.length === 1
      ? `Adding field ${fields[0].name} (${fields[0].scope})`
      : `Adding ${fields.length} fields`,
  );
  const created = [];
  await client.batched((b) => {
    for (const { field, parentLayerId } of planned) {
      created.push({ ...field, id: queueNewField(b, parentLayerId, field, project?.config) });
    }
  });
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
