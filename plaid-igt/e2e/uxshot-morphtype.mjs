// One-off (scratchpad): open a document's Analyze tab, click a morpheme's
// vocab opener to pop the popover, and screenshot the morpheme-type selector.
//   UX_PROJECT_ID=... node e2e/uxshot-morphtype.mjs <documentId> <outPng>
import { chromium } from '@playwright/test';
import { readToken } from './fixtures.js';

const BASE = process.env.IGT_BASE_URL || 'http://localhost:5174';
const PROJECT_ID = process.env.UX_PROJECT_ID;
const [documentId, outPng] = process.argv.slice(2);

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
await page.goto(`${BASE}/#/projects/${PROJECT_ID}/documents/${documentId}`, { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: 'Analyze' }).first().click();
await page.locator('.igt-island').first().waitFor({ state: 'visible', timeout: 8000 });
await page.waitForTimeout(800);

// Open the vocab popover on the first linked MORPHEME chip.
const opener = page.locator('.igt-morph-form .igt-vocab__opener').first();
await opener.click();
await page.locator('.igt-vocab-pop__type select').waitFor({ state: 'visible', timeout: 4000 });
await page.waitForTimeout(300);
await page.screenshot({ path: outPng });
console.log(`wrote ${outPng}`);
await browser.close();
