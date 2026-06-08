// Standalone screenshot/interaction harness for the IGT Analyze (interlinear)
// view. Drives the LIVE dev server (port 5174 -> proxy -> core :8085) with a
// seeded auth token, opens a document's Analyze tab, and writes a PNG. Meant to
// be copied/extended by UX-review agents to capture specific states.
//
// Usage:
//   node e2e/uxshot.mjs <documentId> <outPng> [--width=1400] [--height=900] \
//        [--tab=Analyze] [--full] [--wait=ms]
//
// Examples:
//   node e2e/uxshot.mjs 019ea... /tmp/igt-ux/a-analyze.png
//   node e2e/uxshot.mjs 019ea... /tmp/igt-ux/a-narrow.png --width=700
import { chromium } from '@playwright/test';
import { readToken } from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.IGT_BASE_URL || 'http://localhost:5174';
const PROJECT_ID = process.env.UX_PROJECT_ID || '019ea459-75a1-737a-9f4e-1a2c984a46d7';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const documentId = process.argv[2];
  const outPng = process.argv[3];
  if (!documentId || !outPng) {
    console.error('usage: node e2e/uxshot.mjs <documentId> <outPng> [--width=] [--height=] [--tab=] [--full] [--wait=]');
    process.exit(2);
  }
  const width = parseInt(arg('width', '1400'), 10);
  const height = parseInt(arg('height', '900'), 10);
  const tab = arg('tab', 'Analyze');
  const extraWait = parseInt(arg('wait', '600'), 10);

  const { token, userId } = readToken();
  fs.mkdirSync(path.dirname(outPng), { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height } });
  // Prime auth before the app boots (AuthProvider reads localStorage on mount).
  await context.addInitScript(({ token, userId }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('userId', userId);
    localStorage.setItem('username', userId);
    localStorage.setItem('isAdmin', 'true');
  }, { token, userId });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`${BASE}/#/projects/${PROJECT_ID}/documents/${documentId}`, { waitUntil: 'networkidle' });
  if (tab) {
    const t = page.getByRole('tab', { name: tab });
    if (await t.count()) { await t.first().click(); }
  }
  // Best-effort wait for the island to paint; don't hard-fail empty-state docs.
  await page.locator('.igt-island').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(extraWait);

  await page.screenshot({ path: outPng, fullPage: hasFlag('full') });
  console.log(`wrote ${outPng} (${width}x${height}, tab=${tab}, full=${hasFlag('full')})`);
  if (errors.length) {
    console.log('--- page errors ---');
    for (const e of errors.slice(0, 20)) console.log(e);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
