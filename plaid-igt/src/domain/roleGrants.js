// What each project role grants, in this app's words, for every screen that
// offers the choice: the Access screen's member table, its invitation links,
// and the admin panel's batch of links.
//
// Written once because a reader of one of those screens and a reader of
// another are being told about the same four grants. Naming the levels and
// nothing else left "a Reader cannot comment" to be learned by granting
// someone Reader and hearing about it. Only the maintainer line reads the same
// in both apps, which is why it comes from the shared package.

import { MAINTAINER_HINT, NO_ACCESS_HINT } from '@ui/domain/permissions.js';

export const ROLE_OPTIONS = [
  { value: 'none', label: 'No access', hint: NO_ACCESS_HINT },
  { value: 'reader', label: 'Reader', hint: 'Reads the texts and the lexicon. Cannot comment.' },
  { value: 'writer', label: 'Writer', hint: 'Also edits documents and links vocabulary.' },
  { value: 'maintainer', label: 'Maintainer', hint: MAINTAINER_HINT },
];

// The three a link or a search result can be granted, by value, for a picker
// that offers no way to take access away.
export const ROLE_HINTS = Object.fromEntries(
  ROLE_OPTIONS.filter((o) => o.value !== 'none').map((o) => [o.value, o.hint]),
);
