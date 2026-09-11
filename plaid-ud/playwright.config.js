import { defineConfig, devices } from '@playwright/test';

// PLAYWRIGHT_BASE_URL points the suite at another dev server (e.g. a private
// `npx vite --port 5183` while the shared one on 5173 is mid-change), the way
// plaid-igt's config does. Specs that build their own URLs read it too.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
