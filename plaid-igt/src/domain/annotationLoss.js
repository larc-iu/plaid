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
import { countDeleteLoss, countPartitionLoss, hasOwnContent } from '@ui/domain/annotationLoss.js';

const ZERO = () => ({ annotations: 0, links: 0, shortened: { annotations: 0, links: 0 } });

const linksOf = (vocabularies) =>
  Object.values(vocabularies || {}).flatMap((v) => v?.vocabLinks || []);

const tokenLayersOf = (layerInfo) => layerInfo?.primaryTextLayer?.tokenLayers || [];

// What is deleted, and apart from it what is only cut down (a link over this
// word and the next keeps the next).
const counted = ({ annotations, links, shortened }) => ({ annotations, links, shortened });

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
 * Count annotations a destructive *service* re-tokenize would discard. A
 * tokenizer service resets the sentence partition ONLY when a single sentence
 * covers the whole text and it finds a different one; that cascade-deletes
 * every token in a layer nested (transitively) under the sentence layer, any
 * app's, and every span / relation / vocab-link on them, plus the sentence's
 * own spans. A token's own content (a segmentation, an orthography line: any
 * metadata beyond provenance) counts as one annotation, and so does a stamped
 * token a person verified or contributed. With no sentences the service
 * makes them and deletes nothing (its breaks are countReTokenizeCut's), and
 * with >1 it takes the non-destructive word-only path, so nothing here is
 * lost. Used to surface a confirm before running.
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
 * Count the relations a tokenizer service's new sentence breaks can take on
 * any layer: those a layer keeps inside one sentence whose ends lie at two
 * places of the one sentence the service resplits, or of a text with no
 * sentences, which it gives them (REV-N5-CORE F3). The service decides the
 * breaks, so this is the most they can take. A relation the reset deletes
 * with its tokens is counted by countReTokenizeLoss, not here. Zero when the
 * run leaves the sentences (more than one).
 *
 * @returns {{annotations: number, links: number}}
 */
export const countReTokenizeCut = (layerInfo) => {
  const sentenceLayer = layerInfo?.sentenceTokenLayer;
  const sentenceTokens = sentenceLayer?.tokens || [];
  if (!sentenceLayer || sentenceTokens.length > 1) return ZERO();
  return counted(
    countPartitionLoss(tokenLayersOf(layerInfo), sentenceLayer.id, 'any', {
      deleting: sentenceTokens.map((t) => t.id),
    }),
  );
};

/**
 * Count the annotation loss a MERGE of the given word tokens causes.
 *
 * A merge deletes the words' coincident morphemes (and anything nested under
 * them) in the same batch, cascade-deleting their morpheme-scope spans /
 * relations / vocab links, and a layer that keeps its tokens coextensive with
 * the words loses the merged words' tokens by its rule. Word-scope spans are
 * NOT lost (merge reparents word spans onto the survivor), so unlike
 * countAnnotationLossForWord this counts ONLY what lies under the words.
 * A split takes less: countSplitWordLoss.
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

/**
 * Count the annotation loss a SPLIT of `word` causes. The split deletes the
 * word's coincident morphemes in its batch (a boundary change invalidates
 * their analysis), and with them their spans, the relations on those and
 * their vocabulary links. Another app's token nested under the word is split
 * with it by the server, not deleted, so unlike a merge (where a layer that
 * keeps its tokens coextensive with the words loses them) nothing else is
 * counted.
 *
 * @returns {{annotations: number, links: number}}
 */
export const countSplitWordLoss = (layerInfo, vocabularies, word) => {
  const morphemes = layerInfo?.morphemeTokenLayer?.tokens || [];
  if (!layerInfo?.primaryTokenLayer || !word) return ZERO();
  const ids = morphemes
    .filter((m) => m.begin === word.begin && m.end === word.end)
    .map((m) => m.id);
  if (!ids.length) return ZERO();
  return counted(
    countDeleteLoss(tokenLayersOf(layerInfo), ids, { vocabLinks: linksOf(vocabularies) }),
  );
};
