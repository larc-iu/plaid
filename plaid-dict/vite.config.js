import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const PLAID_CLIENT_SRC = fileURLToPath(new URL('../plaid-client-js/src', import.meta.url));
const IGT_SRC = fileURLToPath(new URL('../plaid-igt/src', import.meta.url));

// Both aliases below point OUTSIDE this app's root, and Vite's watcher only
// covers the root, so edits over there reach no watcher: the dev server keeps
// handing out the copy it transformed at boot. Add them explicitly.
const watchOutsideRoot = (...dirs) => ({
  name: 'watch-outside-root',
  configureServer(server) {
    for (const dir of dirs) server.watcher.add(dir);
  },
});

// plaid-igt's own modules import each other as `@/domain/...`. That specifier
// would hit THIS app's `@` alias and resolve into plaid-dict/src, so rewrite it
// to plaid-igt/src whenever the importer is a plaid-igt file. `enforce: 'pre'`
// puts this ahead of Vite's alias plugin, which would otherwise win.
const igtSelfAlias = () => ({
  name: 'igt-self-alias',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !source.startsWith('@/') || !importer.startsWith(IGT_SRC)) return null;
    const resolved = await this.resolve(`${IGT_SRC}/${source.slice(2)}`, importer, {
      ...options,
      skipSelf: true,
    });
    return resolved?.id ?? null;
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // Bundled into the uberjar and served under /dict/ (see plaid.server.middleware
  // wrap-bundled-spa), so the production build needs an absolute '/dict/' base for
  // asset URLs. The dev server stays at '/'. The app uses HashRouter, so client
  // routes live in the URL fragment and don't depend on the base path.
  base: command === 'build' ? '/dict/' : '/',
  plugins: [igtSelfAlias(), react(), watchOutsideRoot(PLAID_CLIENT_SRC, IGT_SRC)],
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The sense tree, the entry numbering and the reference helpers have ONE
      // definition, plaid-igt's. Numbers on screen are the most visible thing
      // that could drift between the editor and the dictionary.
      '@igt': IGT_SRC,
      // Aliased to its real source path rather than reached through the
      // node_modules symlink: as a "dependency" Vite stamps the import URL with
      // the dep optimizer's `?v=<browserHash>` and serves it back immutable, and
      // that hash comes from the lockfile, not from the client's source. A new
      // client method then arrives as `undefined` in the app forever. Same fix
      // as plaid-igt and plaid-ud.
      '@larc-iu/plaid-client': fileURLToPath(
        new URL('../plaid-client-js/src/index.js', import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    exclude: ['@larc-iu/plaid-client'],
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
