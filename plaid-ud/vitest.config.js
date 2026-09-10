import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Component tests, on happy-dom. The framework-agnostic half of the app
// (ConlluDocument, the Grew engine, the pure utils) is tested by `node --test`
// over test/*.test.js and stays there; what needs a DOM lives beside its
// component as src/**/*.test.jsx. Playwright e2e is separate again, under e2e/.
//
// A vitest.config.js REPLACES vite.config.js rather than merging with it, so
// the app's path aliases have to be restated here, or a test fails to resolve
// rather than failing an assertion.
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
    exclude: ['node_modules', 'dist', 'e2e', 'test'],
  },
});
