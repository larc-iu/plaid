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
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['node_modules', 'dist', 'e2e'],
  },
});
