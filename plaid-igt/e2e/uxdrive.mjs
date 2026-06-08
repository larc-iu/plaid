// Scripted interaction "tour" of the IGT Analyze view: opens a document, then
// captures a gallery of states (idle, editing a cell, morpheme split, vocab
// popover open, narrow viewport, focus ring) as PNGs. Copy & extend for a
// specific review lens. Edits are WRITTEN to the live doc — point it at your
// OWN assigned doc so you don't collide with other agents.
//
// Usage: node e2e/uxdrive.mjs <documentId> <outDir>
import { chromium } from '@playwright/test';
import { readToken } from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.IGT_BASE_URL || 'http://localhost:5174';
const PROJECT_ID = process.env.UX_PROJECT_ID || '019ea459-75a1-737a-9f4e-1a2c984a46d7';

const documentId = process.argv[2];
const outDir = process.argv[3] || '/tmp/igt-ux/tour';
if (!documentId) { console.error('usage: node e2e/uxdrive.mjs <documentId> <outDir>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(outDir, name) });

const { token, userId } = readToken();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addInitScript(({ token, userId }) => {
  localStorage.setItem('token', token);
  localStorage.setItem('userId', userId);
  localStorage.setItem('username', userId);
  localStorage.setItem('isAdmin', 'true');
}, { token, userId });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

async function openAnalyze() {
  await page.goto(`${BASE}/#/projects/${PROJECT_ID}/documents/${documentId}`, { waitUntil: 'networkidle' });
  const t = page.getByRole('tab', { name: 'Analyze' });
  if (await t.count()) await t.first().click();
  await page.locator('.igt-island').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}

await openAnalyze();
await shot(page, '01-idle-1400.png');

// Narrow viewport — exposes horizontal overflow / column clipping.
await page.setViewportSize({ width: 820, height: 900 });
await page.waitForTimeout(300);
await shot(page, '02-narrow-820.png');
await page.setViewportSize({ width: 1400, height: 900 });
await page.waitForTimeout(300);

// Editing a morpheme gloss cell (focus + typing -> shows focus ring + filled state).
const gloss = page.locator('.igt-field[data-cell-key^="ma:"]').first();
if (await gloss.count()) {
  await gloss.click();
  await gloss.fill('NEWGLOSS');
  await shot(page, '03-editing-gloss.png');
  await page.keyboard.press('Escape'); // revert, don't persist this one
}

// Focus ring on a word annotation cell (no typing).
const wcell = page.locator('.igt-field[data-cell-key^="wa:"]').first();
if (await wcell.count()) { await wcell.focus(); await page.waitForTimeout(150); await shot(page, '04-focus-wordcell.png'); await page.keyboard.press('Escape'); }

// Morpheme split: type '-' mid-form in a morpheme form field (persists a real split on YOUR doc).
const mform = page.locator('.igt-morph-field:not(.igt-morph-field--placeholder)').first();
if (await mform.count()) {
  await mform.click();
  await page.keyboard.press('End');
  await page.keyboard.type('-');
  await page.waitForTimeout(700);
  await shot(page, '05-after-split.png');
}

// Vocab-link popover.
const opener = page.locator('.igt-vocab__opener').first();
if (await opener.count()) {
  await opener.click();
  await page.waitForTimeout(300);
  await shot(page, '06-vocab-popover.png');
  await page.keyboard.press('Escape');
}

// Placeholder "+" new-morpheme column focus.
const plus = page.locator('.igt-morph-field--placeholder').first();
if (await plus.count()) { await plus.focus(); await page.waitForTimeout(150); await shot(page, '07-placeholder-focus.png'); }

// Tab order: from the first orthography cell, tab a few times and capture where focus lands.
const first = page.locator('.igt-field').first();
if (await first.count()) {
  await first.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  await shot(page, '08-after-6-tabs.png');
}

console.log(`tour written to ${outDir}`);
if (errs.length) { console.log('--- page errors ---'); for (const e of errs.slice(0, 20)) console.log(e); }
await browser.close();
