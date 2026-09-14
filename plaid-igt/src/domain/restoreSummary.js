// What a restore would change, in this app's words. The reading of the server's
// dry-run summary is shared with plaid-ud (`@ui/domain/restoreSummary.js`);
// what belongs here is the name this app gives each token layer.

import { ROLES, readRole } from '@larc-iu/plaid-client';
import {
  changeLines as changeLinesWith,
  indexLayers as indexLayersWith,
} from '@ui/domain/restoreSummary.js';

export {
  historyMessage,
  latestState,
  restoreError,
  skippedLines,
} from '@ui/domain/restoreSummary.js';

const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: ['sentence', 'sentences'],
  [ROLES.WORD]: ['word', 'words'],
  [ROLES.MORPHEME]: ['morpheme', 'morphemes'],
  [ROLES.TIME_ALIGNMENT]: ['time alignment', 'time alignments'],
};

export const indexLayers = (raw) => indexLayersWith(raw, readRole);

export const changeLines = (summary, layers) => changeLinesWith(summary, layers, TOKEN_ROLE_WORDS);
