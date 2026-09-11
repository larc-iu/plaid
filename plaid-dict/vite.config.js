import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { aliases, IGT_SRC, PLAID_CLIENT_SRC, PLAID_UI_SRC } from './aliases.js';
import { plaidUiDeps } from '../plaid-ui/vite.js';

// Both plaid-client and plaid-igt live OUTSIDE this app's root, and Vite's
// watcher only covers the root, so edits over there reach no watcher: the dev
// server keeps handing out the copy it transformed at boot. Add them.
const watchOutsideRoot = (...dirs) => ({
  name: 'watch-outside-root',
  configureServer(server) {
    for (const dir of dirs) server.watcher.add(dir);
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // Bundled into the uberjar and served under /dict/ (see plaid.server.middleware
  // wrap-bundled-spa), so the production build needs an absolute '/dict/' base for
  // asset URLs. The dev server stays at '/'. The app uses HashRouter, so client
  // routes live in the URL fragment and don't depend on the base path.
  base: command === 'build' ? '/dict/' : '/',
  plugins: [
    react(),
    plaidUiDeps(fileURLToPath(new URL('.', import.meta.url))),
    watchOutsideRoot(PLAID_CLIENT_SRC, IGT_SRC, PLAID_UI_SRC),
  ],
  resolve: {
    preserveSymlinks: true,
    alias: aliases,
  },
  optimizeDeps: {
    exclude: ['@larc-iu/plaid-client', '@larc-iu/plaid-ui'],
  },
  server: {
    port: 5175,
    fs: {
      // Both aliases above resolve outside this app's root.
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
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
