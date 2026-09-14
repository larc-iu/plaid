// The Playwright plumbing both apps' `e2e/fixtures.js` are made of.
//
// The two files were the same 83 lines twice, bar a header comment and one
// extra export: the same JWT reader, the same `seedAuth` writing the same four
// localStorage keys, the same request and console collector. None of it is
// about IGT or about UD, so neither copy could be right about something the
// other was wrong about.
//
// It imports nothing but Node's own modules. This file sits outside both apps
// and can resolve neither Playwright nor `@larc-iu/plaid-client` from here, so
// an app's `fixtures.js` keeps those and hands the rest on.

import fs from 'node:fs';

function parseJwtPayload(token) {
  const payload = token.split('.')[1];
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

// The non-expiring API token an app keeps beside its package.json, and the two
// helpers that read it. `tokenPath` is the app's own `.token`.
export const tokenFixtures = (tokenPath) => {
  const readToken = () => {
    const tok = fs.readFileSync(tokenPath, 'utf8').trim();
    const payload = parseJwtPayload(tok);
    return { token: tok, userId: payload['user/id'] };
  };

  // Plays the role of authService.login(): primes localStorage so AuthContext
  // considers us logged in without going through the UI. Must run BEFORE the
  // app boots, because AuthProvider only reads localStorage in its mount
  // effect.
  const seedAuth = async (page, { token, userId, displayName, isAdmin = true } = {}) => {
    if (!token) {
      const fromFile = readToken();
      token = fromFile.token;
      userId = userId || fromFile.userId;
    }
    displayName = displayName || userId;
    await page.addInitScript(
      ({ token, userId, displayName, isAdmin }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('userId', userId);
        localStorage.setItem('displayName', displayName);
        localStorage.setItem('isAdmin', String(isAdmin));
      },
      { token, userId, displayName, isAdmin },
    );
  };

  return { readToken, seedAuth };
};

// Collect console errors, failed network requests, and every /api/v1/ call
// (with status). Returns plain arrays the test can inspect.
export function collectClientErrors(page) {
  const errors = [];
  const failures = [];
  const apiCalls = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push({ text: msg.text(), location: msg.location() });
    }
  });
  page.on('pageerror', (err) => {
    errors.push({ text: `pageerror: ${err.message}`, stack: err.stack });
  });
  page.on('requestfailed', (req) => {
    failures.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText });
  });
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('/api/v1/')) {
      const entry = { method: resp.request().method(), status: resp.status(), url };
      if (resp.status() >= 400) {
        try {
          entry.body = (await resp.text()).slice(0, 500);
        } catch {
          /* body unavailable */
        }
        failures.push(entry);
      }
      apiCalls.push(entry);
    } else if (resp.status() >= 400) {
      failures.push({ url, method: resp.request().method(), status: resp.status() });
    }
  });
  return { errors, failures, apiCalls };
}

// What a smoke test prints. The assertions in those specs are soft so that
// every surface's diagnostics reach the log even when one of them fails, and
// this is the shape both apps printed them in. Pass `calls` (the dev server's
// URL) to list every /api/v1/ call as well, with that prefix trimmed off.
export function reportDiagnostics(label, { failures, errors, apiCalls } = {}, { calls } = {}) {
  console.log(`\n===== ${label} =====`);
  if (calls) {
    console.log('--- api calls ---');
    for (const c of apiCalls) console.log(`${c.status} ${c.method} ${c.url.replace(calls, '')}`);
  }
  console.log('--- failed requests ---');
  for (const f of failures) console.log(JSON.stringify(f));
  console.log('--- console errors ---');
  for (const e of errors) console.log(JSON.stringify(e));
  if (!failures.length && !errors.length) console.log('(none)');
}
