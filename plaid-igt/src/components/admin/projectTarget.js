import { ownerOf } from '@ui/domain/appOwners.js';
import { readInitialized } from '../../domain/igtConfig';

// Where a project's link leads, for every project link in the admin area.
//
// A project this app owns opens through the router. A project another app
// owns opens in that app (`ownerOf` in the shared package pairs each
// recogniser with the URL that app opens a project at), because this app's
// project route is its setup wizard, and running that over a corpus another
// app set up is the wrong thing to do to someone else's work. A project no
// app recognises opens here, where it can be set up.
//
// `project` is the project as the project list gives it, config and layers
// included: a screen that holds only an id looks it up in the list it read.
//
// The answer is a route in this app (a string) or `{ href }`, a page in
// another app. That is the shape AuditFeed's href builders answer too.
export const projectTarget = (project) => {
  const owner = readInitialized(project.config) ? null : ownerOf(project);
  return owner ? { href: owner.url(project.id) } : `/projects/${project.id}`;
};

/** A document's link: in this app, the document, in another, its project. */
export const documentTarget = (document, project) => {
  const target = projectTarget(project);
  return typeof target === 'string' ? `${target}/documents/${document.id}` : target;
};
