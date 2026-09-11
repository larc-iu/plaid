import { defineConfig, devices } from '@playwright/test';

// PLAYWRIGHT_BASE_URL points the suite at another dev server (e.g. a private
// `npx vite --port 5183` while the shared one on 5173 is mid-change), the way
// plaid-igt's config does. Specs that build their own URLs read it too.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';

// `npm run test:e2e:own` sets this, and the config then starts a dev server of
// its own on that port and stops it afterwards. Without it nothing is started
// and the suite runs against whatever is already at BASE_URL, which is the
// right default for a session that already has one open.
//
// A run against the SHARED server reloads the page of whoever is looking at it,
// and — worse — an edit to `src/` during a run reloads the page under the test,
// which looks exactly like flakiness. Prefer a server of your own.
const OWN_SERVER = process.env.PLAYWRIGHT_OWN_SERVER === '1';

export default defineConfig({
  testDir: './e2e',
  ...(OWN_SERVER
    ? {
        webServer: {
          command: `npx vite --port ${new URL(BASE_URL).port} --strictPort`,
          url: BASE_URL,
          reuseExistingServer: false,
          timeout: 60_000,
        },
      }
    : {}),
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
