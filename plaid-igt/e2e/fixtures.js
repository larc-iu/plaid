import { test as base, expect } from '@playwright/test';
import PlaidClient from '@larc-iu/plaid-client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tokenFixtures,
  collectClientErrors,
  reportDiagnostics,
} from '../../plaid-ui/e2e/appFixtures.js';
import { writeDelayFixtures } from '../../plaid-ui/e2e/writeDelay.js';

// Playwright helpers. Everything app-agnostic lives in plaid-ui/e2e, shared
// with plaid-ud, and what stays here is what this app supplies: Playwright
// itself, the dev server it is pointed at, and the path to its own token.

const TOKEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.token');

// The non-expiring API token for a@b.com.
export const { readToken, seedAuth } = tokenFixtures(TOKEN_PATH);

// A signed-in session for a@b.com, for the few calls a named API token is
// refused (creating an account, minting or revoking API tokens).
export const signInAdmin = (core) => PlaidClient.login(core, 'a@b.com', 'password');

export { collectClientErrors, reportDiagnostics };
// PLAID_E2E_WRITE_DELAY_MS holds the page's writes (see plaid-ui/e2e/writeDelay.js).
export const test = base.extend(writeDelayFixtures);
export { expect };
