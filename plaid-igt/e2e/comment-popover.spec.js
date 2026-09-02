import { test, expect, seedAuth } from './fixtures.js';
import { getFixture } from './fixture.js';

// Escape closes the comment popover. It is not enough for the popover to carry
// its own Escape handler: unlike the vocab popover, the comment one has no
// autofocus target, so focus stays on the badge that opened it and a keydown
// there never reaches the dialog. The close is handled at the container, which
// is what these cover — from the badge, from inside the dialog, and for the
// sentence-level badge, without disturbing the two Escapes that already worked
// (the vocab popover's, and a cell edit's revert).

async function openAnalyze(page) {
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
}

test('Escape closes the comment popover, and hands focus back to its badge', async ({ page }) => {
  await openAnalyze(page);
  await page.locator('.igt-token-form .igt-cmt-badge').first().click();
  await expect(page.locator('.igt-cmt-pop')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.igt-cmt-pop')).toHaveCount(0);
  expect(
    await page.evaluate(() => document.activeElement?.classList.contains('igt-cmt-badge')),
  ).toBe(true);
});

test('Escape closes the comment popover from inside the dialog', async ({ page }) => {
  await openAnalyze(page);
  await page.locator('.igt-token-form .igt-cmt-badge').first().click();
  await page.locator('.igt-cmt-pop textarea').first().click();
  expect(await page.evaluate(() => !!document.activeElement?.closest('.igt-cmt-pop'))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('.igt-cmt-pop')).toHaveCount(0);
});

test('Escape closes the sentence comment popover', async ({ page }) => {
  await openAnalyze(page);
  await page.locator('.igt-sentence__num .igt-cmt-badge').first().click();
  await expect(page.locator('.igt-cmt-pop')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.igt-cmt-pop')).toHaveCount(0);
});

test('Escape still closes the vocab popover and still reverts a cell edit', async ({ page }) => {
  await openAnalyze(page);
  await page.locator('.igt-vocab__link').first().click({ force: true });
  await expect(page.locator('.igt-vocab-pop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.igt-vocab-pop')).toHaveCount(0);

  const field = page.locator('.igt-cell .igt-field').first();
  const saved = await field.inputValue();
  await field.click();
  await field.fill('ZZTOP');
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue(saved);
});
