import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the framework-agnostic domain layer.
//
// A vitest.config.js REPLACES vite.config.js rather than merging with it, so
// the app's path aliases have to be restated here — including `@igt`, since the
// domain modules read plaid-igt's sense-tree helpers.
export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@igt': fileURLToPath(new URL('../plaid-igt/src', import.meta.url)),
      // Straight to the source, matching vite.config.js — see the note there
      // about the dep optimizer's immutable `?v=` cache.
      '@larc-iu/plaid-client': fileURLToPath(
        new URL('../plaid-client-js/src/index.js', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
