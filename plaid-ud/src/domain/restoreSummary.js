// What a restore would change, in this app's words. The reading of the server's
// dry-run summary is shared with plaid-igt; what belongs here is the name this
// app gives each token layer.
//
// The shared module is imported by its REAL relative path, not through `@ui`,
// because the `node --test` suite loads this file and no alias exists there. It
// is the same file `@ui/domain/restoreSummary.js` resolves to, and it imports
// nothing outside the package, which is what lets node load it.

import { ROLES, readRole } from '@larc-iu/plaid-client';
import {
  changeLines as changeLinesWith,
  indexLayers as indexLayersWith,
} from '../../../plaid-ui/src/domain/restoreSummary.js';

export {
  historyMessage,
  latestState,
  restoreError,
  skippedLines,
} from '../../../plaid-ui/src/domain/restoreSummary.js';

// UD terminology: the `word`-role layer holds orthographic TOKENS and the
// `syntactic-word`-role layer holds WORDS. See the UI terminology convention —
// this is the user-facing half, so it does not follow the internal names.
const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: ['sentence', 'sentences'],
  [ROLES.WORD]: ['token', 'tokens'],
  [ROLES.SYNTACTIC_WORD]: ['word', 'words'],
};

export const indexLayers = (raw) => indexLayersWith(raw, readRole);

export const changeLines = (summary, layers) => changeLinesWith(summary, layers, TOKEN_ROLE_WORDS);
