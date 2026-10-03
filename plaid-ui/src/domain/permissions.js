// Per-project access, derived from the project's permission arrays
// (`maintainers` / `writers` / `readers`, all user-id lists) plus the user's
// global `isAdmin` flag. Single source of truth so every screen agrees on what
// a given user may do.
//
//   - Editing documents/annotations/text requires WRITE access
//     (maintainer, writer, or admin).
//   - Configuring project layers and deleting projects requires MAINTAINER
//     access (or admin).
//   - Readers get everything in read-only mode.
//
// The server enforces all of this regardless; these helpers drive the UI so a
// user is never shown an action they can't perform.

// What the two app-agnostic levels grant, said where the choice is made.
//
// Reader and Writer read differently per app, because what a writer edits is
// texts and a lexicon in one and a treebank in the other. These two do not:
// no access is no access, and a maintainer's powers are the server's, so the
// line must not drift between the four screens that show it.
export const NO_ACCESS_HINT = 'Cannot open the project.';
export const MAINTAINER_HINT = 'Also changes settings and members, and deletes the project.';

const inList = (list, id) => Array.isArray(list) && id != null && list.includes(id);

// The mark on the project a document keeps once the document was deleted
// while open (DocumentModel `_documentGone`): nobody writes through it, an
// admin included, and its read-only reason says why. A symbol, so it never
// reaches the server or a comparison of config.
export const DOCUMENT_DELETED = Symbol.for('plaid.documentDeleted');

/** `project` marked as seen from a deleted document. */
export const asDeletedDocument = (project) => ({ ...project, [DOCUMENT_DELETED]: true });

const deleted = (project) => !!project?.[DOCUMENT_DELETED];

export const canEditProject = (project, user) =>
  !deleted(project) &&
  !!(user?.isAdmin || inList(project?.maintainers, user?.id) || inList(project?.writers, user?.id));

export const canManageProject = (project, user) =>
  !deleted(project) && !!(user?.isAdmin || inList(project?.maintainers, user?.id));

// Whether the project opens at all. An admin reads every project, so a screen
// asking "is this person a member" wants `projectRole` instead.
export const canReadProject = (project, user) =>
  !!(canEditProject(project, user) || inList(project?.readers, user?.id));

// Why a document is read-only for someone who cannot write it: it was
// deleted while open, a reader, or someone who holds no role any more
// (removed while the page was open).
export const readOnlyReason = (project, user) => {
  if (deleted(project)) return 'This document was deleted.';
  return canReadProject(project, user)
    ? 'You have reader access to this project.'
    : 'You no longer have access to this project.';
};

// Explicit membership, for a member table or an "add me to this project" offer,
// is `projectRole` in `@larc-iu/plaid-client`. It is not repeated here.

// A vocabulary carries its own maintainer list, and nothing else. Its
// maintainers (or an admin) change its settings and maintainers, link it to a
// project (core refuses anyone else), and rename or delete its entries. Adding
// an entry and linking a word to one need only write access to the word's
// project (acl-shared-vocab-writers b). igt's Entries screen and Bulk Add stay
// with the maintainers all the same.
export const canManageVocabulary = (vocabulary, user) =>
  !!(user?.isAdmin || inList(vocabulary?.maintainers, user?.id));
