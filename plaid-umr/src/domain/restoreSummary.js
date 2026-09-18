// What this app calls each token-layer role, for the restore confirm step's
// change lines. The reading of the server's dry-run summary is shared with the
// other apps (`@ui/domain/restoreSummary.js`); the words are what belongs here.
//
// The UMR node layer is not among these: it carries no role, being this app's
// own, so the dialog falls back to the layer's name for it.

import { ROLES } from '@larc-iu/plaid-client';

export const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: ['sentence', 'sentences'],
  [ROLES.WORD]: ['word', 'words'],
  [ROLES.MORPHEME]: ['morpheme', 'morphemes'],
};
