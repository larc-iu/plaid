// What this app calls each token-layer role, for the restore confirm step's
// change lines. The reading of the server's dry-run summary is shared with the
// other apps (`@ui/domain/restoreSummary.js`); the words are what belongs here.
//
// This app's own layers are named by `UMR_LAYER_WORDS` instead. A node is one
// span and the token or tokens anchoring it, so it is counted once, as a node,
// and its tokens are left out.
//
// Each role's or layer's words are `{ count, scope }`: `count(n)` the counted
// phrase whole ("3 words") and `scope` the word that tells two fields of one
// name apart ("word" in "word Gloss"). `scope` is read when the line is made,
// so it is a getter: this table is read before the language is known.

import { ROLES } from '@larc-iu/plaid-client';
import { hasFlag, UMR_LAYER_FLAGS } from '../utils/umrLayerUtils.js';
// By its real path rather than through `@ui`: the node suite runs this file.
import { t } from '../../../plaid-ui/src/lib/i18n.js';

export const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: {
    count: (n) => t('{n, plural, one {# sentence} other {# sentences}}', { n }),
    get scope() {
      return t('sentence');
    },
  },
  [ROLES.WORD]: {
    count: (n) => t('{n, plural, one {# word} other {# words}}', { n }),
    get scope() {
      return t('word');
    },
  },
  [ROLES.MORPHEME]: {
    count: (n) => t('{n, plural, one {# morpheme} other {# morphemes}}', { n }),
    get scope() {
      return t('morpheme');
    },
  },
};

const NODES = {
  count: (n) => t('{n, plural, one {# node} other {# nodes}}', { n }),
  get scope() {
    return t('node');
  },
};
const EDGES = {
  count: (n) => t('{n, plural, one {# edge} other {# edges}}', { n }),
  get scope() {
    return t('edge');
  },
};
const DOCUMENT_RELATIONS = {
  count: (n) =>
    t('{n, plural, one {# document-level relation} other {# document-level relations}}', { n }),
  get scope() {
    return t('document-level relation');
  },
};

export const UMR_LAYER_WORDS = (config) => {
  const layer = { config };
  if (hasFlag(layer, UMR_LAYER_FLAGS.nodes)) return null;
  if (hasFlag(layer, UMR_LAYER_FLAGS.concepts)) return NODES;
  if (hasFlag(layer, UMR_LAYER_FLAGS.relations)) return EDGES;
  if (hasFlag(layer, UMR_LAYER_FLAGS.documentGraph)) return DOCUMENT_RELATIONS;
  return undefined;
};
