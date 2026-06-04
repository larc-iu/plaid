import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture } from './fixture.js';

// Diagnostic smoke tests: drive the main surfaces against live plaid-core and
// surface any API failures / console errors. Assertions are soft so every
// surface's diagnostics print even when one fails.

function report(label, { apiCalls, failures, errors }) {
  console.log(`\n===== ${label} =====`);
  console.log('--- failed requests ---');
  for (const f of failures) console.log(JSON.stringify(f));
  console.log('--- console errors ---');
  for (const e of errors) console.log(JSON.stringify(e));
  if (!failures.length && !errors.length) console.log('(none)');
}

test('project list loads', async ({ page }) => {
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await page.goto('/#/projects');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  report('project list', diag);
  const body = await page.locator('body').innerText();
  console.log('--- visible (300) ---\n', body.slice(0, 300));
  await expect.soft(page.getByText(/Failed to load|Error loading/i)).toHaveCount(0);
  expect.soft(diag.failures, 'no API failures').toEqual([]);
});

test('project detail loads', async ({ page }) => {
  const { projectId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  report('project detail', diag);
  await expect.soft(page.getByText(/Failed to load|Error loading/i)).toHaveCount(0);
  expect.soft(diag.failures, 'no API failures').toEqual([]);
});

test('document editor loads', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  report('document editor', diag);
  const body = await page.locator('body').innerText();
  console.log('--- visible (500) ---\n', body.slice(0, 500));
  await expect.soft(page.getByText(/Failed to load|Error loading/i)).toHaveCount(0);
  expect.soft(diag.failures, 'no API failures').toEqual([]);
});

test('vocabularies list loads', async ({ page }) => {
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await page.goto('/#/vocabularies');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  report('vocabularies', diag);
  await expect.soft(page.getByText(/Failed to load|Error loading/i)).toHaveCount(0);
  expect.soft(diag.failures, 'no API failures').toEqual([]);
});
