// The layers a run over many documents reads (`?layers=`), from igt's own
// layer tree. The reads themselves go through plaid-ui's lib/documentReads.js
// (readInOrder, readAll), four at a time.
//
// Each read asks only for the layers the run looks at: a respell reads the
// text, the words, the morphemes and their links, and not the annotation
// fields, which are most of a document.

import {
  findAlignmentTokenLayer,
  findBaselineTextLayer,
  findMorphemeTokenLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
} from './igtConfig.js';
import { getIgtLayerInfo } from './layerInfo.js';

/**
 * The layer ids a document read names in `?layers=`, from the project's own
 * layer tree. Always the baseline text layer, whose text a row quotes.
 *
 * - `tokenLayers`: `'igt'` for this app's four (sentences, words, morphemes,
 *   time alignment), or `'all'` for every token layer of every text layer in
 *   the project, for a run that must see each vocabulary link wherever it
 *   hangs (a link comes back with the token layer it is on).
 * - `spans`: `'igt'` for every annotation field of this app (the span layers
 *   the editor reads), or an array of span layer ids, empty for none.
 *
 * Null when the project has no baseline text layer: the run reads everything,
 * as it would without this.
 */
export function readLayerIds(project, { tokenLayers = 'igt', spans = 'igt' } = {}) {
  const textLayers = project?.textLayers || [];
  const baseline = findBaselineTextLayer(textLayers);
  if (!baseline?.id) return null;
  const ids = new Set([baseline.id]);
  if (tokenLayers === 'all') {
    for (const tl of textLayers) for (const tkl of tl.tokenLayers || []) ids.add(tkl.id);
  } else {
    const own = baseline.tokenLayers || [];
    for (const find of [
      findSentenceTokenLayer,
      findWordTokenLayer,
      findMorphemeTokenLayer,
      findAlignmentTokenLayer,
    ]) {
      const layer = find(own);
      if (layer) ids.add(layer.id);
    }
  }
  if (spans === 'igt') {
    const { spanLayers } = getIgtLayerInfo(project);
    for (const sl of [...spanLayers.word, ...spanLayers.morpheme, ...spanLayers.sentence]) {
      ids.add(sl.id);
    }
  } else {
    for (const id of spans || []) if (id) ids.add(id);
  }
  ids.delete(undefined);
  return [...ids];
}
