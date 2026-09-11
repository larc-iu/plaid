// Where the other Plaid SPAs live.
//
// The release jar bundles plaid-ud, plaid-igt and plaid-dict together and
// serves them at /ud/, /igt/ and /dict/ (see plaid-core's middleware and
// bb/pipeline.clj), so that is the default. In development each runs on its own
// Vite port, which `VITE_IGT_URL` names.
//
// A link across apps is a full page load, never a router Link: the other app is
// a different document with its own bundle and its own hash router.

const trimSlash = (url) => url.replace(/\/+$/, '');

export const IGT_URL = trimSlash(import.meta.env.VITE_IGT_URL || '/igt');

/**
 * The server's admin area, which is plaid-igt's. The jar always ships both
 * apps, so there is exactly one admin area per server and UD links to it rather
 * than growing a second.
 */
export const adminUrl = () => `${IGT_URL}/#/admin`;
