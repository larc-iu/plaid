// The dev-server config `bb e2e` starts an app's Vite with: the app's own
// vite.config.js, with its /api proxy sent to the private core of the run
// (PLAID_CORE_URL) instead of the shared dev core, and its dependency cache in
// a directory of the run's own (PLAID_E2E_VITE_CACHE), so it never shares one
// with the dev server.
//
// Vite runs from the app's directory, so the app's config is the one in the
// working directory. It is imported at run time rather than by a static path,
// which keeps this one file for every app.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export default async (env) => {
  const target = process.env.PLAID_CORE_URL;
  if (!target) throw new Error('PLAID_CORE_URL is unset: this config is for `bb e2e`');
  const { default: app } = await import(pathToFileURL(path.resolve('vite.config.js')).href);
  const config = typeof app === 'function' ? await app(env) : { ...app };
  const proxy = config.server?.proxy ?? {};
  return {
    ...config,
    cacheDir: process.env.PLAID_E2E_VITE_CACHE || config.cacheDir,
    server: { ...config.server, proxy: { ...proxy, '/api': { ...proxy['/api'], target } } },
  };
};
