// The vocabularies a document's links name, read for an IgtDocument built
// outside its project's own screen (a concordance, a dictionary's examples).
// A linked morpheme goes by its entry's morph type (R2), and the document
// GET embeds each linked entry as a bare {id, form}, so a document read with
// no vocabularies joins a clitic with "-" and sets no type. A vocabulary that
// cannot be read is left out, and its morphemes go by their own types.

import { loadProjectVocabularies, rebaseVocabLinks } from './IgtDocument.js';

/** The ids of the vocabularies a raw document's links name. */
export const linkedVocabIds = (raw) => {
  const ids = new Set();
  for (const textLayer of raw?.textLayers || []) {
    for (const tokenLayer of textLayer.tokenLayers || []) {
      for (const v of tokenLayer.vocabs || []) if (v?.id) ids.add(v.id);
    }
  }
  return [...ids];
};

/**
 * The `vocabularies` to build an IgtDocument of `raw` with: each vocabulary
 * its links name, with its entries and none of its links (the constructor
 * folds the document's own in).
 */
export async function documentVocabularies(client, raw) {
  const ids = linkedVocabIds(raw);
  if (!ids.length) return {};
  const { vocabularies } = await loadProjectVocabularies(client, {
    vocabs: ids.map((id) => ({ id })),
  });
  return rebaseVocabLinks(vocabularies);
}
