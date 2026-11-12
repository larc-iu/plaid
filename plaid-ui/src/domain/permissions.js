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
export const MAINTAINER_HINT =
  'Also changes settings and members, and deletes the project and its vocabularies.';

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

// An assistant job: a writer starts one, on the project's documents.
export const canStartJob = canEditProject;

// Stops `job` (cancels it): the person who started it while they still write
// the project, or a maintainer (an admin is one).
export const canStopJob = (job, project, user) =>
  canManageProject(project, user) ||
  (job?.startedBy != null && job.startedBy === user?.id && canEditProject(project, user));

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

// A vocabulary belongs to one project, its home (`vocabulary.project`), and
// its rights are the home's roles and nothing else. Another project may link
// it as a borrower: its people read it and link words to its entries, and
// change no entry. Each question takes the home project as the caller has it
// (with its role lists), or null when the caller has none: a screen inside a
// project passes that project for its own vocabulary and null for a borrowed
// one, which is then read only there even for someone who is also in the
// home. A vocabulary-centred screen reads the home itself and passes null when
// the read is refused.

/**
 * The caller's role over `vocabulary`: 'maintainer', 'writer', 'reader' or
 * null. Null when `home` is not the vocabulary's home (missing, or another
 * project). An admin is a maintainer.
 */
export const vocabularyRole = (vocabulary, home, user) => {
  if (!vocabulary?.project || !home || home.id !== vocabulary.project) return null;
  if (canManageProject(home, user)) return 'maintainer';
  if (canEditProject(home, user)) return 'writer';
  if (canReadProject(home, user)) return 'reader';
  return null;
};

// Renames, moves and deletes the vocabulary, changes its settings, renames,
// merges, deletes and restores its entries, lists the projects that borrow it
// and ends a borrowing. A delete is refused (409) while a borrower links it.
export const canManageVocabulary = (vocabulary, home, user) =>
  vocabularyRole(vocabulary, home, user) === 'maintainer';

// Adds entries and changes anything stored on one: fields, type, senses and
// their order, homograph order, examples.
export const canEditVocabularyEntries = (vocabulary, home, user) => {
  const role = vocabularyRole(vocabulary, home, user);
  return role === 'maintainer' || role === 'writer';
};

/** Whether `vocabulary` belongs to a project other than `project`. */
export const isBorrowed = (vocabulary, project) =>
  !!vocabulary && vocabulary.project !== project?.id;

// Links `vocabulary` into `project` as a borrower: a maintainer of `project`
// who holds any role in the home.
export const canLinkVocabulary = (vocabulary, home, project, user) =>
  canManageProject(project, user) && vocabularyRole(vocabulary, home, user) !== null;

// Unlinks `vocabulary` from `project`: a maintainer of that project, or a
// maintainer of the home ending the borrowing (`project` then needs only its
// id). Never from the home itself.
export const canUnlinkVocabulary = (vocabulary, project, home, user) =>
  !!project &&
  isBorrowed(vocabulary, project) &&
  (canManageProject(project, user) || canManageVocabulary(vocabulary, home, user));

// Makes `target` the vocabulary's home: a maintainer of both projects.
export const canMoveVocabulary = (vocabulary, home, target, user) =>
  canManageVocabulary(vocabulary, home, user) && canManageProject(target, user);
