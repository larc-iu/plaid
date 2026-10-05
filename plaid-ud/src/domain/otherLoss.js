// What a delete in this editor takes on the text's OTHER layers, whoever made
// them, beyond what this editor counts of its own (the syntactic words and
// everything on them). Counted by layer, naming no app, with plaid-ui's
// counter. Shared by the Text Editor's Delete token (ConlluDocument) and the
// Grew preview (grew/rewrite/diff.js).
//
// By its real path: the node suite loads this file, and the counter imports
// nothing itself.
import { PROVENANCE_KEYS } from '../../../plaid-client-js/src/provenance.js';
import { countDeleteLoss } from '../../../plaid-ui/src/domain/annotationLoss.js';

// A token's own content counts as an annotation, as Clear tokens counts it: a
// morpheme's form, an orthography line, a sentence's note (REV-N5-APPS R5).
// The one key this editor writes on a token it shares, a multiword token's
// `form`, is its own and counted with its own.
const contentOf = (layerInfo) => {
  const wordLayerId = layerInfo?.wordTokenLayer?.id;
  return (token, layerId) =>
    Object.keys(token?.metadata || {}).some(
      (k) => !PROVENANCE_KEYS.includes(k) && !(layerId === wordLayerId && k === 'form'),
    );
};

/**
 * What deleting the tokens `ids` takes on the other layers:
 * `{ annotations, links, shortened, relationIds }`, `shortened` being the
 * annotations and links only cut down to the tokens they keep.
 */
export const otherDeleteLoss = (layerInfo, ids) => {
  const own = layerInfo?.morphemeTokenLayer ? [layerInfo.morphemeTokenLayer.id] : [];
  const loss = countDeleteLoss(layerInfo?.textLayer?.tokenLayers || [], ids, {
    skip: own,
    content: contentOf(layerInfo),
  });
  return { annotations: loss.annotations, links: loss.links, shortened: loss.shortened };
};
