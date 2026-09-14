// What this app calls each token-layer role, for the restore confirm step's
// change lines. The reading of the server's dry-run summary is shared with
// plaid-ud (`@ui/domain/restoreSummary.js`); the words are what belongs here.

import { ROLES } from '@larc-iu/plaid-client';

export const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: ['sentence', 'sentences'],
  [ROLES.WORD]: ['word', 'words'],
  [ROLES.MORPHEME]: ['morpheme', 'morphemes'],
  [ROLES.TIME_ALIGNMENT]: ['time alignment', 'time alignments'],
};
