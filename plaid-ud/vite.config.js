import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // Bundled into the uberjar and served under /ud/ (see plaid.server.middleware
  // wrap-bundled-spa), so the production build needs an absolute '/ud/' base for
  // asset URLs. The dev server stays at '/'. Both apps use HashRouter, so client
  // routes live in the URL fragment and don't depend on the base path.
  base: command === 'build' ? '/ud/' : '/',
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
    alias: {
      // `plaid-client` is a local source package (../plaid-client-js) that we
      // edit constantly. Reaching it through the node_modules symlink makes
      // Vite treat it as a DEPENDENCY: the import URL gets the dep optimizer's
      // `?v=<browserHash>` stamped on it and is served back
      // `Cache-Control: max-age=31536000, immutable`. That hash is derived from
      // the lockfile, NOT from the symlink target's source, so once a browser
      // has the module it never re-fetches it, no matter how the client
      // changes. The symptom is a brand-new client method arriving as
      // `undefined` in the app while curl against the same dev server shows it
      // present, and neither restarting the dev server nor deleting
      // node_modules/.vite changes the hash. `optimizeDeps.exclude` alone does
      // NOT fix this: it skips pre-bundling but the `?v=` and the immutable
      // header stay. Aliasing straight to the real source path takes it out of
      // dependency-land entirely, so it is served as an ordinary first-party
      // module (`no-cache`, watched, hot-reloaded).
      '@larc-iu/plaid-client': fileURLToPath(
        new URL('../plaid-client-js/src/index.js', import.meta.url),
      ),
    },
  },
  // Belt and braces alongside the resolve.alias above: keep the client out of
  // dep pre-bundling so nothing re-introduces a cached bundle of it. The alias
  // is what actually fixes the stale-module problem (see the comment there);
  // exclusion alone was tried first and was NOT sufficient.
  optimizeDeps: {
    exclude: ['@larc-iu/plaid-client'],
  },
  server: {
    port: 5173,
    fs: {
      // The plaid-client alias above resolves outside this app's root.
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
    // node_modules is watcher-ignored by default, but `plaid-client` is a
    // symlinked local source package we actively edit during the SQL port.
    // Un-ignore it so saves there trigger HMR like first-party files.
    watch: {
      ignored: ['!**/node_modules/@larc-iu/plaid-client/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8085',
        changeOrigin: true,
        secure: false,
      },
    },
  },
}));
