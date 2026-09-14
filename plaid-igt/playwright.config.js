import { defineConfig, devices } from '@playwright/test';

// Mirrors plaid-ud's config. The Vite dev server (port 5174) proxies /api -> :8085,
// so the app talks to the live plaid-core.
// PLAYWRIGHT_BASE_URL points the suite at another dev server (e.g. a private
// `npx vite --port 5175` while the shared one is mid-change).
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
const PORT = new URL(BASE_URL).port;

// `npm run test:e2e:own` sets this, and the config then starts a dev server of
// its own on that port and stops it afterwards. Without it the shared one is
// started if it is not already up, and reused if it is.
//
// A run against the SHARED server reloads the page of whoever is looking at it,
// and, worse, an edit to `src/` during a run reloads the page under the test,
// which looks exactly like flakiness. Prefer a server of your own.
const OWN_SERVER = process.env.PLAYWRIGHT_OWN_SERVER === '1';

export default defineConfig({
  testDir: './e2e',
  // Two runs from this directory clobber each other's `.playwright-artifacts-*`
  // and fail with `browserContext.close: ENOENT`, which reads exactly like a
  // test failure and is not. A run on its own server keeps its own directory,
  // named by the port only it is using.
  outputDir: OWN_SERVER ? `test-results/${PORT}` : 'test-results',
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
    command: OWN_SERVER ? `npx vite --port ${PORT} --strictPort` : 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !OWN_SERVER,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
