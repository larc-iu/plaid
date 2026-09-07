import { defineConfig } from 'vitest/config';
import { aliases } from './aliases.js';

// Unit tests for the framework-agnostic domain layer.
//
// A vitest.config.js REPLACES vite.config.js rather than merging with it, so
// the app's aliases have to be restated here. They are shared from aliases.js
// so the two configs cannot drift.
export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: aliases,
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
