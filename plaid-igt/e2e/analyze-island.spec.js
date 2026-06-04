import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture } from './fixture.js';

// Exercises the vanilla interlinear island end-to-end against live plaid-core:
// renders the grid, edits a morpheme gloss, and verifies the edit round-trips
// through IgtDocument -> server -> reload -> re-render.

async function openAnalyze(page, projectId, documentId) {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
}

test('interlinear grid renders token + morpheme columns', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  const cols = page.locator('.igt-island .igt-token-col');
  expect(await cols.count()).toBeGreaterThan(1);
  // morpheme form fields present (one per seeded morpheme)
  expect(await page.locator('.igt-island .igt-morph-field').count()).toBeGreaterThan(0);
  // row labels include the configured fields
  await expect.soft(page.locator('.igt-row-label', { hasText: 'Part of Speech' })).toBeVisible();

  console.log('--- failed requests ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  console.log('--- console errors ---');
  for (const e of diag.errors) console.log(JSON.stringify(e));
  expect.soft(diag.failures, 'no API failures while rendering').toEqual([]);
});

test('editing a morpheme gloss persists across reload', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  const cell = page.locator('.igt-field[data-cell-key^="ma:"]').first();
  await cell.click();
  await cell.fill('TESTGLOSS');
  await cell.press('Enter'); // commit on blur
  // wait for the span create/update round trip
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);

  console.log('--- failed requests after edit ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  expect.soft(diag.failures, 'no API failures on edit').toEqual([]);

  // Reload the whole page and re-open analyze: the value must survive the
  // full server round-trip + re-derivation.
  await openAnalyze(page, projectId, documentId);
  const reloaded = page.locator('.igt-field[data-cell-key^="ma:"]').first();
  await expect(reloaded).toHaveValue('TESTGLOSS');
});
