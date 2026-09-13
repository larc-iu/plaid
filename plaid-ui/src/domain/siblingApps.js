// Where the other Plaid SPAs live.
//
// The release jar bundles plaid-ud, plaid-igt and plaid-dict together and
// serves them at /ud/, /igt/ and /dict/ (see plaid-core's middleware and
// bb/pipeline.clj), so that is the default. In development each runs on its own
// Vite port, which `VITE_UD_URL` / `VITE_IGT_URL` / `VITE_DICT_URL` name.
//
// One map, here, rather than each app holding the half it happened to need:
// the deployment is one server serving all three, so where they sit is a fact
// about the server and not about any one app.
//
// A link across apps is a full page load, never a router Link: the other app is
// a different document with its own bundle and its own hash router.

const trimSlash = (url) => url.replace(/\/+$/, '');

export const UD_URL = trimSlash(import.meta.env.VITE_UD_URL || '/ud');
export const IGT_URL = trimSlash(import.meta.env.VITE_IGT_URL || '/igt');
export const DICT_URL = trimSlash(import.meta.env.VITE_DICT_URL || '/dict');

/** A UD project's own page in plaid-ud. */
export const udProjectUrl = (projectId) => `${UD_URL}/#/projects/${projectId}/documents`;

/** An IGT project's own page in plaid-igt. */
export const igtProjectUrl = (projectId) => `${IGT_URL}/#/projects/${projectId}`;

/**
 * The server's admin area, which is plaid-igt's. The jar always ships every
 * app, so there is exactly one admin area per server and the others link to it
 * rather than growing a second.
 */
export const adminUrl = () => `${IGT_URL}/#/admin`;
