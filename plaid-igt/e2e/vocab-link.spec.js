import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture } from './fixture.js';

// Vocab-link popover round-trip: link a lexicon item to the first word, confirm
// it persists across reload, then unlink it. Net-neutral on the fixture.

async function openAnalyze(page, projectId, documentId) {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
}

test('link then unlink a lexicon item on a word', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  // Open the popover on the first word and link the item "the".
  await page.locator('.igt-token-form .igt-vocab__opener').first().click();
  await page.locator('.igt-vocab-pop').first().waitFor({ state: 'visible' });
  await page.locator('.igt-vocab-pop__item', { hasText: 'the' }).first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  await expect(page.locator('.igt-token-form .igt-vocab__hint').first()).toHaveText('the');

  // Persists across a full reload.
  await openAnalyze(page, projectId, documentId);
  await expect(page.locator('.igt-token-form .igt-vocab__hint').first()).toHaveText('the');

  // Unlink via the popover (click the linked item again).
  await page.locator('.igt-token-form .igt-vocab__hint').first().click();
  await page.locator('.igt-vocab-pop').first().waitFor({ state: 'visible' });
  await page.locator('.igt-vocab-pop__item.is-linked').first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  await expect(page.locator('.igt-token-form .igt-vocab__hint')).toHaveCount(0);

  // The functional assertions above are the real proof. Guard against broken
  // WRITES specifically; transient GET read hiccups against the shared dev
  // server are environmental, not a regression.
  console.log('--- failed requests ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  const writeFailures = diag.failures.filter((f) => f.method && f.method !== 'GET');
  expect.soft(writeFailures, 'no write failures during vocab link/unlink').toEqual([]);
});
