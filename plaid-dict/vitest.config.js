import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { aliases } from './aliases.js';
import { plaidUiDeps } from '../plaid-ui/vite.js';

// Unit tests for the framework-agnostic domain layer.
//
// A vitest.config.js REPLACES vite.config.js rather than merging with it, so
// the app's aliases have to be restated here. They are shared from aliases.js
// so the two configs cannot drift.
export default defineConfig({
  plugins: [plaidUiDeps(fileURLToPath(new URL('.', import.meta.url)))],
  // plaid-igt and plaid-ui both sit outside this app's root.
  server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  resolve: {
    preserveSymlinks: true,
    alias: aliases,
  },
  test: {
    setupFiles: ['./src/test/setup.js'],
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
