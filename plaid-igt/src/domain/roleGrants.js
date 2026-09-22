// What each project role grants, in this app's words, for every screen that
// offers the choice: the Access screen's member table, its invitation links,
// and the admin panel's batch of links.
//
// Written once because a reader of one of those screens and a reader of
// another are being told about the same four grants. Naming the levels and
// nothing else left "a Reader cannot comment" to be learned by granting
// someone Reader and hearing about it. Only the two lines that name what this
// app holds are here: the other two read the same in every app and come from
// the shared package, which builds all four.

import { grantRoleHints, projectRoleOptions } from '@ui/domain/projectRoles.js';

export const ROLE_OPTIONS = projectRoleOptions({
  readerHint: 'Reads the texts and the lexicon. Cannot comment.',
  writerHint: 'Also edits documents and links vocabulary.',
});

// The three a link or a search result can be granted, by value, for a picker
// that offers no way to take access away.
export const ROLE_HINTS = grantRoleHints(ROLE_OPTIONS);
