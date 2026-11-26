// What this app calls each token-layer role, for the restore confirm step's
// change lines. The reading of the server's dry-run summary is shared with
// plaid-igt (`@ui/domain/restoreSummary.js`); the words are what belongs here.
//
// UD terminology: the `word`-role layer holds orthographic TOKENS and the
// `syntactic-word`-role layer holds WORDS. See the UI terminology convention —
// this is the user-facing half, so it does not follow the internal names.
//
// Each role's words are `{ count, scope }`: `count(n)` the counted phrase
// whole ("3 words") and `scope` the word that tells two fields of one name
// apart ("word" in "word Gloss"). `scope` is read when the line is made, so
// it is a getter: this table is read before the language is known.
//
// By its real path: the `node --test` suite has no `@ui` alias.

import { ROLES } from '@larc-iu/plaid-client';
import { t } from '../../../plaid-ui/src/lib/i18n.js';

export const TOKEN_ROLE_WORDS = {
  [ROLES.SENTENCE]: {
    count: (n) => t('{n, plural, one {# sentence} other {# sentences}}', { n }),
    get scope() {
      return t('sentence');
    },
  },
  [ROLES.WORD]: {
    count: (n) => t('{n, plural, one {# token} other {# tokens}}', { n }),
    get scope() {
      return t('token');
    },
  },
  [ROLES.SYNTACTIC_WORD]: {
    count: (n) => t('{n, plural, one {# word} other {# words}}', { n }),
    get scope() {
      return t('word');
    },
  },
};
