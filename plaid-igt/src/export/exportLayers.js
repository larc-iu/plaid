// Discover the exportable tier inventory of a project — the same layer
// resolution as layerInfo.js / importEngine.js, but off a bare
// `client.projects.get()` result (no document fetch needed), and reduced to
// the names a wizard renders checkboxes for.
//
// Pure functions; tolerant of arbitrary configurations (apps other than IGT,
// partial setups, missing layers) — absent buckets come back as empty arrays,
// never undefined.

import {
  findBaselineTextLayer,
  findWordTokenLayer,
  findSentenceTokenLayer,
  findMorphemeTokenLayer,
  readScope,
  readDocumentMetadata,
  readOrthographies,
} from '../domain/igtConfig.js';
import { fieldLangsOf, fieldRolesOf } from '../domain/fieldInventory.js';

/**
 * @returns {{ orthographies: string[], wordFields: string[],
 *             morphFields: string[], sentFields: string[], hasMorphemes: boolean,
 *             fieldLangs: Object<string, string>,
 *             fieldRoles: Object<string, string> }}
 *   fieldLangs is keyed "<scope>:<name>", since one name can be a field at
 *   more than one scope ("Gloss" on words and on morphemes). So is
 *   fieldRoles, each field's stored role (fieldRolesOf): a sentence field's
 *   own, a word or morpheme field's the entry role its Lexicon field holds.
 */
export function discoverExportLayers(project) {
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  const tokenLayers = textLayer?.tokenLayers || [];
  const wordLayer = findWordTokenLayer(tokenLayers);
  const sentenceLayer = findSentenceTokenLayer(tokenLayers);
  const morphemeLayer = findMorphemeTokenLayer(tokenLayers);

  const names = (layer, scopes) =>
    (layer?.spanLayers || [])
      .filter((sl) => scopes.includes(readScope(sl.config)))
      .map((sl) => sl.name);

  // The writing system each field records, for the exporters that have to tag
  // their output with one. Absent for a field nobody told.
  const fieldLangs = fieldLangsOf(project);

  const fieldRoles = {};
  for (const [scope, byName] of Object.entries(fieldRolesOf(project))) {
    for (const [name, role] of Object.entries(byName)) fieldRoles[`${scope}:${name}`] = role;
  }

  return {
    fieldLangs,
    fieldRoles,
    orthographies: (readOrthographies(wordLayer?.config) || [])
      .map((o) => o?.name)
      .filter((n) => typeof n === 'string' && n !== ''),
    wordFields: names(wordLayer, ['Word']),
    morphFields: names(morphemeLayer, ['Morpheme']),
    sentFields: names(sentenceLayer, ['Sentence']),
    hasMorphemes: !!morphemeLayer,
    // The document metadata fields, by name.
    documentMetadata: (readDocumentMetadata(project?.config) || [])
      .map((m) => m?.name)
      .filter((n) => typeof n === 'string' && n !== ''),
  };
}

/**
 * Reconcile a saved tier selection with the currently discovered inventory:
 * stale names are dropped, order follows the inventory. A missing/garbled
 * selection degrades to empty arrays rather than throwing.
 */
export function intersectSelection(selection, layers) {
  const pick = (sel, avail) => {
    const wanted = new Set(Array.isArray(sel) ? sel : []);
    return (avail || []).filter((n) => wanted.has(n));
  };
  return {
    ...selection,
    orthographies: pick(selection?.orthographies, layers.orthographies),
    wordFields: pick(selection?.wordFields, layers.wordFields),
    morphFields: pick(selection?.morphFields, layers.morphFields),
    sentFields: pick(selection?.sentFields, layers.sentFields),
  };
}
