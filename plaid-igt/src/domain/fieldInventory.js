// The project's field inventory: which fields it has, by scope, and what each
// one's stored record says (its role, its language). Read off a bare
// `client.projects.get()` result, so the importers that add to a project, the
// exporters and the settings screens read one walk of the same layers.
//
// Pure. Tolerant of a project with no baseline or no fields: every scope an
// answer is keyed by comes back empty, never undefined, where the shape says so.

import {
  findBaselineTextLayer,
  readFieldLang,
  readLexiconField,
  readScope,
  readSentenceRole,
} from './igtConfig.js';
import { entryRolesByKey } from './lexiconField.js';

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
 * Each field's role, by scope and name, `{scope: {name: role}}`: what fills a
 * service's `field` parameter that names a role. A word or morpheme field's is
 * the entry role its stored Lexicon field holds (entryRolesByKey), a sentence
 * field's its stored role (readSentenceRole).
 */
export const fieldRolesOf = (project) => {
  const roleOfKey = entryRolesByKey(project?.vocabs);
  const out = {};
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  for (const tl of textLayer?.tokenLayers || []) {
    for (const sl of tl.spanLayers || []) {
      const scope = readScope(sl.config);
      const role =
        scope === 'Sentence' ? readSentenceRole(sl.config) : roleOfKey[readLexiconField(sl.config)];
      if (scope && role) (out[scope] ??= {})[sl.name] = role;
    }
  }
  return out;
};

/**
 * The language each field records, keyed "<scope>:<name>", since one name can
 * be a field at more than one scope ("Gloss" on words and on morphemes). For
 * the exporters that have to tag their output with one. Absent for a field
 * nobody told.
 */
export const fieldLangsOf = (project) => {
  const out = {};
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  for (const tl of textLayer?.tokenLayers || []) {
    for (const sl of tl.spanLayers || []) {
      const scope = readScope(sl.config);
      const lang = readFieldLang(sl.config);
      if (scope && lang) out[`${scope}:${sl.name}`] = lang;
    }
  }
  return out;
};
