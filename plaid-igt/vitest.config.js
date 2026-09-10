import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { PLAID_UI_SRC, plaidUiDeps } from '../plaid-ui/vite.js';

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
  plugins: [plaidUiDeps(fileURLToPath(new URL('.', import.meta.url)))],
  // The shared package's own test files sit outside this app's root, so the
  // module server has to be allowed to read them.
  server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@ui': PLAID_UI_SRC,
      // Straight to the source, matching vite.config.js — see the long note
      // there about the dep optimizer's immutable `?v=` cache.
      '@larc-iu/plaid-client': fileURLToPath(
        new URL('../plaid-client-js/src/index.js', import.meta.url),
      ),
    },
  },
  test: {
    setupFiles: ['./src/test/setup.js'],
    environment: 'happy-dom',
    globals: true,
    // The shared package's tests run here, not under every app: they need a
    // React and a happy-dom, and three runs would learn the same thing three
    // times. See ../plaid-ui/README.md.
    include: ['src/**/*.{test,spec}.{js,jsx}', '../plaid-ui/src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['node_modules', 'dist', 'e2e'],
  },
});
