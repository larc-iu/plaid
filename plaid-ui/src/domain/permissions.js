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

export const canEditProject = (project, user) =>
  !!(user?.isAdmin || inList(project?.maintainers, user?.id) || inList(project?.writers, user?.id));

export const canManageProject = (project, user) =>
  !!(user?.isAdmin || inList(project?.maintainers, user?.id));

// 'maintainer' | 'writer' | 'reader' | 'none'
export const projectAccessLevel = (project, user) => {
  if (!user || !project) return 'none';
  if (user.isAdmin || inList(project.maintainers, user.id)) return 'maintainer';
  if (inList(project.writers, user.id)) return 'writer';
  if (inList(project.readers, user.id)) return 'reader';
  return 'none';
};
