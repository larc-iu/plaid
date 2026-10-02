// Where the other Plaid SPAs live.
//
// The release jar bundles plaid-ud, plaid-igt, plaid-umr and plaid-dict
// together and serves them at /ud/, /igt/, /umr/ and /dict/ (see plaid-core's
// middleware and bb/pipeline.clj), so that is the default. In development each
// runs on its own Vite port, which `VITE_UD_URL`, `VITE_IGT_URL` and
// `VITE_UMR_URL` name.
//
// One map, here, rather than each app holding the half it happened to need:
// the deployment is one server serving all of them, so where they sit is a
// fact about the server and not about any one app.
//
// A link across apps is a full page load, never a router Link: the other app is
// a different document with its own bundle and its own hash router.

const trimSlash = (url) => url.replace(/\/+$/, '');

const UD_URL = trimSlash(import.meta.env.VITE_UD_URL || '/ud');
const IGT_URL = trimSlash(import.meta.env.VITE_IGT_URL || '/igt');
const UMR_URL = trimSlash(import.meta.env.VITE_UMR_URL || '/umr');

/** A UD project's own page in plaid-ud. */
export const udProjectUrl = (projectId) => `${UD_URL}/#/projects/${projectId}/documents`;

/** A UMR project's own page in plaid-umr. */
export const umrProjectUrl = (projectId) => `${UMR_URL}/#/projects/${projectId}/documents`;

/**
 * The server's admin area, which is plaid-igt's. The jar always ships every
 * app, so there is exactly one admin area per server and the others link to it
 * rather than growing a second.
 */
export const adminUrl = () => `${IGT_URL}/#/admin`;

/**
 * The root of the server an app is served from, given the app's own base (Vite's
 * `base`, which is `import.meta.env.BASE_URL` at runtime) and the page's URL.
 *
 * The jar serves each app one directory below its root (`/igt/`), so the root
 * is the app's base with its last segment taken off: `/igt/` gives `/`, and a
 * build for a server under a prefix (`base: '/plaid/igt/'`) gives `/plaid/`. A
 * relative base resolves against the page first. A dev server serves the app at
 * its own root (`/`), and that is where it leads there: the jar's landing page
 * is the jar's, and a dev server has none.
 */
export const serverRootPath = (base, pageUrl) => {
  const dir = new URL(base || '/', pageUrl).pathname.replace(/\/?$/, '/');
  return dir === '/' ? '/' : dir.replace(/[^/]+\/$/, '');
};

/** The root of the server this app is served from (see `serverRootPath`). */
export const serverRootUrl = () => serverRootPath(import.meta.env.BASE_URL, window.location.href);
