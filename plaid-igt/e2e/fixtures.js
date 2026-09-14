import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tokenFixtures,
  collectClientErrors,
  reportDiagnostics,
} from '../../plaid-ui/e2e/appFixtures.js';

// Playwright helpers. Everything app-agnostic lives in plaid-ui/e2e, shared
// with plaid-ud, and what stays here is what this app supplies: Playwright
// itself, the dev server it is pointed at, and the path to its own token.

// The dev server the suite runs against, matching playwright.config.js. A spec
// that builds absolute URLs (or trims them out of a log line) reads it here
// rather than writing the port again.
export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';

const TOKEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.token');

// The non-expiring API token for a@b.com.
export const { readToken, seedAuth } = tokenFixtures(TOKEN_PATH);

export { collectClientErrors, reportDiagnostics };
export const test = base.extend({});
export { expect };
