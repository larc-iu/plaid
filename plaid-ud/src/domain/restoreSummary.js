// What this app calls each token-layer role, for the restore confirm step's
// change lines. The reading of the server's dry-run summary is shared with
// plaid-igt (`@ui/domain/restoreSummary.js`); the words are what belongs here.
//
// UD terminology: the `word`-role layer holds orthographic TOKENS and the
// `syntactic-word`-role layer holds WORDS. See the UI terminology convention —
// this is the user-facing half, so it does not follow the internal names.

import { ROLES } from '@larc-iu/plaid-client';

export const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: ['sentence', 'sentences'],
  [ROLES.WORD]: ['token', 'tokens'],
  [ROLES.SYNTACTIC_WORD]: ['word', 'words'],
};
