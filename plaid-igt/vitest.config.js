import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the framework-agnostic domain layer (IgtDocument + mutations)
// and pure utils. happy-dom gives the island/DOM tests a lightweight document.
// Playwright e2e lives under e2e/ and is run separately via `npm run test:e2e`.
//
// A vitest.config.js REPLACES vite.config.js rather than merging with it, so
// the app's path aliases have to be restated here. Island code reaches for both
// of them (`@/domain/...`, and `@larc-iu/plaid-client` for the provenance
// helpers), and without them an island test fails to resolve rather than fails
// an assertion.
export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@ui': fileURLToPath(new URL('./node_modules/@larc-iu/plaid-ui/src', import.meta.url)),
      // Straight to the source, matching vite.config.js — see the long note
      // there about the dep optimizer's immutable `?v=` cache.
      '@larc-iu/plaid-client': fileURLToPath(
        new URL('../plaid-client-js/src/index.js', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    // The shared package's tests run here, not under every app: they need a
    // React and a happy-dom, and three runs would learn the same thing three
    // times. See ../plaid-ui/README.md.
    include: [
      'src/**/*.{test,spec}.{js,jsx}',
      // Through the symlink, not ../plaid-ui/src: a test file collected at its
      // real path resolves its own bare imports from ../plaid-ui, which has no
      // node_modules.
      'node_modules/@larc-iu/plaid-ui/src/**/*.{test,spec}.{js,jsx}',
    ],
    exclude: ['dist', 'e2e', 'node_modules/.*', 'node_modules/[^@]*', 'node_modules/@[^l]*'],
    server: {
      // A path under node_modules is externalized by default and handed to
      // node's own loader, which resolves the symlink back to ../plaid-ui and
      // then cannot find `marked`. Inlined, Vite transforms it and resolves its
      // imports with `preserveSymlinks`, which keeps the walk inside this app.
      deps: { inline: [/@larc-iu\/plaid-ui/] },
    },
  },
});
