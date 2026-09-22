import { isUdProject } from './udProject.js';
import { isUmrProject } from './umrProject.js';
import { udProjectUrl, umrProjectUrl } from './siblingApps.js';

// Which app a project belongs to, for the screens that list everybody's.
//
// Recognising another app's project is a frontend question about that app's
// private config namespace, so each rule lives here rather than in the API
// client (`udProject.js`, `umrProject.js`), and where each app's projects open
// is `siblingApps.js`. This is the two of them paired, once: the admin listing
// used to hold its own table of shape names, recognisers and URLs, so a fourth
// app meant remembering a screen in another app.
//
// The app doing the asking is NOT in here. It recognises its own projects from
// its own config module, which is private to it, and it opens them through its
// own router rather than as a page load.
export const APP_OWNERS = [
  { tag: 'ud', shape: 'UD', owns: isUdProject, url: udProjectUrl },
  { tag: 'umr', shape: 'UMR', owns: isUmrProject, url: umrProjectUrl },
];

/** The app that owns this project, or null for one no rule here recognises. */
export const ownerOf = (project) => APP_OWNERS.find((o) => o.owns(project)) ?? null;
