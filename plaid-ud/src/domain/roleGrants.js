// What each project role grants, in this app's words, for every screen that
// offers the choice: the Access screen's member table and its invitation links.
// The two lines that read the same in every app come from the shared package.
// The hints are messages: the shared screens call t() on them.
import { projectRoleOptions } from '@ui/domain/projectRoles.js';
import { msg } from '@ui/lib/i18n.js';

export const ROLE_OPTIONS = projectRoleOptions({
  readerHint: msg('Reads the treebank. Cannot comment.'),
  writerHint: msg('Also edits documents and their annotation, and deletes documents.'),
});
