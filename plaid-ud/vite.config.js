import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // Bundled into the uberjar and served under /ud/ (see plaid.server.middleware
  // wrap-bundled-spa), so the production build needs an absolute '/ud/' base for
  // asset URLs. The dev server stays at '/'. Both apps use HashRouter, so client
  // routes live in the URL fragment and don't depend on the base path.
  base: command === 'build' ? '/ud/' : '/',
  plugins: [react()],
  resolve: {
    preserveSymlinks: true
  },
  // `plaid-client` is a symlinked local package (../plaid-client-js). Vite's
  // dep pre-bundling caches it under node_modules/.vite/deps and does NOT
  // invalidate when the symlink target's source changes — so edits to the
  // client would silently serve a stale bundle (the OCC-409 / "missing
  // method" class of bug). Excluding it from optimizeDeps makes Vite serve it
  // as source through the normal module graph, so edits hot-reload like any
  // first-party file.
  optimizeDeps: {
    exclude: ['@larc-iu/plaid-client']
  },
  server: {
    port: 5173,
    // node_modules is watcher-ignored by default, but `plaid-client` is a
    // symlinked local source package we actively edit during the SQL port.
    // Un-ignore it so saves there trigger HMR like first-party files.
    watch: {
      ignored: ['!**/node_modules/@larc-iu/plaid-client/**']
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8085',
        changeOrigin: true,
        secure: false
      }
    }
  }
}))
