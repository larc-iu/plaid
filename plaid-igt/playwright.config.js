import { defineConfig, devices } from '@playwright/test';

// Mirrors plaid-ud's config. The Vite dev server (port 5174) proxies /api -> :8085,
// so the app talks to the live plaid-core. We auto-start it but reuse an existing
// one if the user already has `npm run dev` up.
// PLAYWRIGHT_BASE_URL points the suite at another dev server (e.g. a private
// `npx vite --port 5175` while the shared one is mid-change).
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
