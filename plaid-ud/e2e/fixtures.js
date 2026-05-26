import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, '..', '.token');

function parseJwtPayload(token) {
  const payload = token.split('.')[1];
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

export function readToken() {
  const tok = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  const payload = parseJwtPayload(tok);
  return { token: tok, userId: payload['user/id'] };
}

// Plays the role of authService.login() — primes localStorage so AuthContext
// considers us logged in without going through the UI. Must run *before* the
// app boots, because AuthProvider only reads localStorage in its mount effect.
export async function seedAuth(page, { token, userId, username, isAdmin = true } = {}) {
  if (!token) {
    const fromFile = readToken();
    token = fromFile.token;
    userId = userId || fromFile.userId;
  }
  username = username || userId;
  await page.addInitScript(({ token, userId, username, isAdmin }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('userId', userId);
    localStorage.setItem('username', username);
    localStorage.setItem('isAdmin', String(isAdmin));
  }, { token, userId, username, isAdmin });
}

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
        try { entry.body = (await resp.text()).slice(0, 500); } catch {}
        failures.push(entry);
      }
      apiCalls.push(entry);
    } else if (resp.status() >= 400) {
      failures.push({ url, method: resp.request().method(), status: resp.status() });
    }
  });
  return { errors, failures, apiCalls };
}

export const test = base.extend({});
export { expect };
