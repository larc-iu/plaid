// What a delete, split or merge in this editor destroys, counted across ALL
// apps' layers by plaid-ui's countDeleteLoss: the word and every token nested
// under it, any app's, with their spans, the relations on those spans and the
// vocabulary links. Much of that is invisible in this editor, so each of these
// is gated on the count: zero -> it runs at once (the high-frequency
// mid-tokenization case), nonzero -> a confirm naming what goes. Deletion is
// FINAL: the old undo-snapshot only restored IGT's own layers, which silently
// lost other apps' material while reporting success.
//
// The links are read from the doc's vocabularies map, which holds the links
// made since the document was read.

import { PROV, isProtected } from '@larc-iu/plaid-client';
import { countDeleteLoss, hasOwnContent } from '@ui/domain/annotationLoss.js';

const ZERO = () => ({ annotations: 0, links: 0 });

const linksOf = (vocabularies) =>
  Object.values(vocabularies || {}).flatMap((v) => v?.vocabLinks || []);

const tokenLayersOf = (layerInfo) => layerInfo?.primaryTextLayer?.tokenLayers || [];

const counted = ({ annotations, links }) => ({ annotations, links });

/**
 * Count the annotations deleting `word` would cascade away.
 *
 * @param {object} layerInfo  getIgtLayerInfo result (primaryTextLayer retains
 *   the FULL tokenLayers list, other apps' layers included)
 * @param {object} vocabularies  the doc's vocabularies map
 * @param {object} word  the word token {id, begin, end}
 * @returns {{annotations: number, links: number}} spans + relations, and vocab links
 */
export const countAnnotationLossForWord = (layerInfo, vocabularies, word) => {
  if (!layerInfo?.primaryTokenLayer || !word) return ZERO();
  return counted(
    countDeleteLoss(tokenLayersOf(layerInfo), [word.id], { vocabLinks: linksOf(vocabularies) }),
  );
};

/**
 * Count what deleting a stretch of the baseline would take: every word
 * overlapping it and all that cascades from those words, plus every sentence
 * lying wholly inside it, which the server deletes with its spans. A segment
 * on the Media tab is such a stretch, and its trash goes straight through
 * when this is zero.
 *
 * @returns {{annotations: number, links: number}}
 */
export const countAnnotationLossForRange = (layerInfo, vocabularies, begin, end) => {
  if (!layerInfo || !(end > begin)) return ZERO();
  const ids = [
    ...(layerInfo.primaryTokenLayer?.tokens || []).filter((w) => w.begin < end && w.end > begin),
    ...(layerInfo.sentenceTokenLayer?.tokens || []).filter((s) => s.begin >= begin && s.end <= end),
  ].map((t) => t.id);
  return counted(
    countDeleteLoss(tokenLayersOf(layerInfo), ids, { vocabLinks: linksOf(vocabularies) }),
  );
};

/**
 * Count annotations a destructive *service* re-tokenize would discard. A
 * tokenizer service resets the sentence partition ONLY when a single sentence
 * covers the whole text and it finds a different one; that cascade-deletes
 * every token in a layer nested (transitively) under the sentence layer, any
 * app's, and every span / relation / vocab-link on them, plus the sentence's
 * own spans. A token's own content (a segmentation, an orthography line: any
 * metadata beyond provenance) counts as one annotation, and so does a stamped
 * token a person verified or contributed. With zero or >1
 * sentences the service takes the non-destructive word-only path, so nothing
 * here is lost. Used to surface a confirm before running.
 *
 * @returns {{annotations: number, links: number}}
 */
export const countReTokenizeLoss = (layerInfo, vocabularies) => {
  const sentenceTokens = layerInfo?.sentenceTokenLayer?.tokens || [];
  if (sentenceTokens.length !== 1) return ZERO(); // non-destructive path
  // A person's merge or split of a machine tokenizer's token leaves only
  // provenance, verified or contributed.
  const content = (t) =>
    hasOwnContent(t) || (PROV.key in (t.metadata || {}) && isProtected(t.metadata));
  return counted(
    countDeleteLoss(tokenLayersOf(layerInfo), [sentenceTokens[0].id], {
      vocabLinks: linksOf(vocabularies),
      content,
    }),
  );
};

/**
 * Count the annotation loss a SPLIT or MERGE of the given word token(s) causes.
 *
 * Split/merge delete the words' coincident morphemes (and anything nested under
 * them) in the same batch, cascade-deleting their morpheme-scope spans /
 * relations / vocab links. Word-scope spans are NOT lost (split resizes the
 * word in place, merge reparents word spans onto the survivor), so unlike
 * countAnnotationLossForWord this counts ONLY what lies under the words.
 *
 * @param {object} layerInfo  getIgtLayerInfo result
 * @param {object} vocabularies  the doc's vocabularies map
 * @param {object[]} words  the affected word token(s) [{id, begin, end}, …]
 * @returns {{annotations: number, links: number}}
 */
export const countSubWordAnnotationLoss = (layerInfo, vocabularies, words) => {
  const list = (words || []).filter(Boolean);
  if (!layerInfo?.primaryTokenLayer || list.length === 0) return ZERO();
  return counted(
    countDeleteLoss(
      tokenLayersOf(layerInfo),
      list.map((w) => w.id),
      { under: true, vocabLinks: linksOf(vocabularies) },
    ),
  );
};
