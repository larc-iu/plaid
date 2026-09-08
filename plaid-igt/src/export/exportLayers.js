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
  readFieldLang,
  readScope,
  readOrthographies,
} from '../domain/igtConfig.js';

/**
 * @returns {{ orthographies: string[], wordFields: string[],
 *             morphFields: string[], sentFields: string[], hasMorphemes: boolean,
 *             fieldLangs: Object<string, string> }}
 *   fieldLangs is keyed "<scope>:<name>", since one name can be a field at
 *   more than one scope ("Gloss" on words and on morphemes).
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
  const fieldLangs = {};
  for (const tl of textLayer?.tokenLayers || []) {
    for (const sl of tl.spanLayers || []) {
      const scope = readScope(sl.config);
      const lang = readFieldLang(sl.config);
      if (scope && lang) fieldLangs[`${scope === 'Token' ? 'Word' : scope}:${sl.name}`] = lang;
    }
  }

  return {
    fieldLangs,
    orthographies: (readOrthographies(wordLayer?.config) || [])
      .map((o) => o?.name)
      .filter((n) => typeof n === 'string' && n !== ''),
    wordFields: names(wordLayer, ['Word', 'Token']),
    morphFields: names(morphemeLayer, ['Morpheme']),
    sentFields: names(sentenceLayer, ['Sentence']),
    hasMorphemes: !!morphemeLayer,
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
