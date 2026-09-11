// Where the other Plaid SPAs live.
//
// The release jar bundles plaid-ud, plaid-igt and plaid-dict together and
// serves them at /ud/, /igt/ and /dict/ (see plaid-core's middleware and
// bb/pipeline.clj), so that is the default. In development each runs on its own
// Vite port, which `VITE_UD_URL` / `VITE_IGT_URL` name.
//
// A link across apps is a full page load, never a router Link: the other app is
// a different document with its own bundle and its own hash router.

const trimSlash = (url) => url.replace(/\/+$/, '');

export const UD_URL = trimSlash(import.meta.env.VITE_UD_URL || '/ud');

/** A UD project's own page in plaid-ud. */
export const udProjectUrl = (projectId) => `${UD_URL}/#/projects/${projectId}/documents`;
