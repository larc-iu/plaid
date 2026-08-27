import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // Bundled into the uberjar and served under /igt/ (see plaid.server.middleware
  // wrap-bundled-spa), so the production build needs an absolute '/igt/' base for
  // asset URLs. The dev server stays at '/'. The app uses HashRouter, so client
  // routes live in the URL fragment and don't depend on the base path.
  base: command === 'build' ? '/igt/' : '/',
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // `plaid-client` is a symlinked local package (../plaid-client-js). Vite's
  // dep pre-bundling caches it under node_modules/.vite/deps and serves it with
  // an immutable, year-long Cache-Control keyed on a `?v=` hash that does NOT
  // change when the symlink target's source does — so an edit to the client
  // kept being served as a stale bundle even across a dev-server restart, and
  // only a cache-bypassing reload fixed it. The symptom is a brand-new client
  // method arriving as `undefined` while curl against the same endpoint works.
  // Excluding it makes Vite serve it as source through the normal module graph,
  // so edits hot-reload like any first-party file. plaid-ud has carried this
  // since the SQL port; igt was missing it (bit us on the invites UI).
  optimizeDeps: {
    exclude: ['@larc-iu/plaid-client'],
  },
  server: {
    port: 5174,
    // node_modules is watcher-ignored by default, but `plaid-client` is a
    // symlinked local source package we actively edit. Un-ignore it so saves
    // there trigger HMR like first-party files.
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
