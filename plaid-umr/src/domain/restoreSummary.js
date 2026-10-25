// What this app calls each token-layer role, for the restore confirm step's
// change lines. The reading of the server's dry-run summary is shared with the
// other apps (`@ui/domain/restoreSummary.js`); the words are what belongs here.
//
// This app's own layers are named by `UMR_LAYER_WORDS` instead. A node is one
// span and the token or tokens anchoring it, so it is counted once, as a node,
// and its tokens are left out.

import { ROLES } from '@larc-iu/plaid-client';
import { hasFlag, UMR_LAYER_FLAGS } from '../utils/umrLayerUtils.js';

export const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: ['sentence', 'sentences'],
  [ROLES.WORD]: ['word', 'words'],
  [ROLES.MORPHEME]: ['morpheme', 'morphemes'],
};

export const UMR_LAYER_WORDS = (config) => {
  const layer = { config };
  if (hasFlag(layer, UMR_LAYER_FLAGS.nodes)) return null;
  if (hasFlag(layer, UMR_LAYER_FLAGS.concepts)) return ['node', 'nodes'];
  if (hasFlag(layer, UMR_LAYER_FLAGS.relations)) return ['edge', 'edges'];
  if (hasFlag(layer, UMR_LAYER_FLAGS.documentGraph))
    return ['document-level relation', 'document-level relations'];
  return undefined;
};
