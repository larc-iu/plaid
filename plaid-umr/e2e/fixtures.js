import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tokenFixtures,
  collectClientErrors,
  reportDiagnostics,
} from '../../plaid-ui/e2e/appFixtures.js';

// Playwright helpers. Everything app-agnostic lives in plaid-ui/e2e, shared
// with the other apps, and what stays here is what this app supplies:
// Playwright itself, the dev server it is pointed at, and the path to its own
// token.

// The dev server the suite is pointed at, matching playwright.config.js.
export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5176';

const TOKEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.token');

// The non-expiring API token for a@b.com.
export const { readToken, seedAuth } = tokenFixtures(TOKEN_PATH);

export { collectClientErrors, reportDiagnostics };

// What a spec asserts on: the failed requests and console errors, less the
// one 404 every session sees. A person who has never rebound a key has no
// keymap entry, and the browser logs the read as a failed resource.
export const cleanDiagnostics = (diag) => {
  const failures = diag.failures.filter((f) => !f.url.includes('/data/umr%3Akeymap'));
  const errors = diag.errors.filter(
    (e) => !(e.text.startsWith('Failed to load resource') && failures.length === 0),
  );
  return { failures, errors };
};
export const test = base.extend({});
export { expect };
