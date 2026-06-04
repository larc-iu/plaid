import { defineConfig } from 'vitest/config';

// Unit tests for the framework-agnostic domain layer (IgtDocument + mutations)
// and pure utils. happy-dom gives the island/DOM tests a lightweight document.
// Playwright e2e lives under e2e/ and is run separately via `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['node_modules', 'dist', 'e2e'],
  },
});
