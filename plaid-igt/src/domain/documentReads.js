// Reading many documents for one run: the Bulk Edit previews and Export.
//
// Both need every affected document in full, and on a large project that is
// thousands of reads. One at a time, the run is almost all waiting: 1,413
// reads took 52 seconds for one respell preview. Four at a time, the server's
// readers work side by side, which is the bound the assistants' corpus reader
// uses too (plaid-agent `core/docload.py`, WORKERS = 4) and well under the
// server's ten pooled connections, so a run never takes every connection from
// the people editing.
//
// Each read also asks only for the layers the run looks at (`?layers=`): a
// respell reads the text, the words, the morphemes and their links, and not
// the annotation fields, which are most of a document.

import {
  findAlignmentTokenLayer,
  findBaselineTextLayer,
  findMorphemeTokenLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
} from './igtConfig.js';
import { getIgtLayerInfo } from './layerInfo.js';

/** Reads in flight at once, for a run over many documents. */
export const READS_IN_FLIGHT = 4;

/**
 * Run `read(id)` for every id, at most `inFlight` at a time, and yield each
 * outcome in the order of `ids`: `{ id, value }`, or `{ id, error }` when the
 * read failed. A read is started only while fewer than `inFlight` outcomes
 * are waiting for the caller, so however slowly the caller takes them, no
 * more than that many documents are held. Leaving the loop early starts no
 * further reads; the ones already sent finish and are dropped.
 */
export async function* readInOrder(ids, read, { inFlight = READS_IN_FLIGHT } = {}) {
  const pending = new Array(ids.length);
  let started = 0;
  let taken = 0;
  let stopped = false;
  const fill = () => {
    while (!stopped && started < ids.length && started - taken < inFlight) {
      const id = ids[started];
      pending[started] = Promise.resolve()
        .then(() => read(id))
        .then(
          (value) => ({ id, value }),
          (error) => ({ id, error }),
        );
      started += 1;
    }
  };
  try {
    while (taken < ids.length) {
      fill();
      const outcome = await pending[taken];
      pending[taken] = undefined;
      taken += 1;
      // The next read goes out before the caller works on this one.
      fill();
      yield outcome;
    }
  } finally {
    stopped = true;
  }
}

/**
 * Every read's value, in the order of `ids`, `inFlight` at a time. The first
 * failure fails the whole run and sends nothing further.
 * `onProgress(done, total)` follows the reads as they are taken.
 */
export async function readAll(ids, read, { onProgress, inFlight } = {}) {
  const out = [];
  for await (const { value, error } of readInOrder(ids, read, { inFlight })) {
    if (error) throw error;
    out.push(value);
    onProgress?.(out.length, ids.length);
  }
  return out;
}

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
