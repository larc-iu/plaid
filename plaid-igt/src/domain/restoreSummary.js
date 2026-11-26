// What this app calls each token-layer role, for the restore confirm step's
// change lines. The reading of the server's dry-run summary is shared with
// plaid-ud (`@ui/domain/restoreSummary.js`); the words are what belongs here.
//
// Each role's words are `{ count, scope }`: `count(n)` the counted phrase
// whole ("3 words") and `scope` the word that tells two fields of one name
// apart ("word" in "word Gloss"). `scope` is read when the line is made, so
// it is a getter: this table is read before the language is known.

import { ROLES } from '@larc-iu/plaid-client';
import { t } from '@ui/lib/i18n.js';

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
  [ROLES.TIME_ALIGNMENT]: {
    count: (n) => t('{n, plural, one {# time alignment} other {# time alignments}}', { n }),
    get scope() {
      return t('time alignment');
    },
  },
};
