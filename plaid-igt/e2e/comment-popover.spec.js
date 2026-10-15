import { test, expect, seedAuth } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

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

// Deleting a comment is permanent: comments are unaudited, so there is no
// history entry to restore from and no undo. The grid asks first, with the
// same dialog the rest of the app asks with.
test('deleting a comment from the grid asks first', async ({ page }) => {
  await openAnalyze(page);
  const badge = page.locator('.igt-token-form .igt-cmt-badge').first();
  await badge.click();
  const pop = page.locator('.igt-cmt-pop');
  await expect(pop).toBeVisible();

  const body = `delete me ${Date.now()}`;
  await pop.locator('textarea').fill(body);
  await pop.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(pop.getByText(body)).toBeVisible();

  // Refusing the dialog keeps it.
  await pop.locator('[aria-label="Delete this comment"]').last().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  await badge.click();
  await expect(page.locator('.igt-cmt-pop').getByText(body)).toBeVisible();

  await page.locator('.igt-cmt-pop [aria-label="Delete this comment"]').last().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await badge.click();
  await expect(page.locator('.igt-cmt-pop').getByText(body)).toHaveCount(0);
});

// H15-IGT polish: the switch to Comments opened the project's stream twice
// (one aborted at once) and read every comment twice, since the tab's claim on
// the stream was given up and taken again in one turn.
test('the Comments tab opens one stream and reads the comments once', async ({ page }) => {
  await openAnalyze(page);
  const seen = { listen: 0, comments: 0 };
  page.on('request', (r) => {
    if (/\/listen(\?|$)/.test(r.url())) seen.listen += 1;
    if (/\/comments\?/.test(r.url())) seen.comments += 1;
  });
  await page.getByRole('tab', { name: 'Comments' }).click();
  await expect(page).toHaveURL(/tab=comments/);
  await page.waitForTimeout(1500);
  expect(seen).toEqual({ listen: 1, comments: 1 });
});

// H16-UI-CORE-4: with an Analyze comment popover open, the switch to Comments
// gave up the popover's claim on the stream when Analyze unmounted, and the
// tab's claim came about 60 ms later: the stream was aborted, opened again,
// and every comment read again.
test('the Comments tab keeps the stream an open comment popover holds', async ({ page }) => {
  await openAnalyze(page);
  const seen = { listen: 0, comments: 0, aborted: 0 };
  page.on('request', (r) => {
    if (/\/listen(\?|$)/.test(r.url())) seen.listen += 1;
    if (/\/comments\?/.test(r.url())) seen.comments += 1;
  });
  page.on('requestfailed', (r) => {
    if (/\/listen(\?|$)/.test(r.url())) seen.aborted += 1;
  });
  await page.locator('.igt-token-form .igt-cmt-badge').first().click();
  await expect(page.locator('.igt-cmt-pop')).toBeVisible();
  await page.waitForTimeout(500);
  const before = { ...seen };
  await page.getByRole('tab', { name: 'Comments' }).click();
  await expect(page).toHaveURL(/tab=comments/);
  await page.waitForTimeout(1500);
  expect(before.listen).toBe(1);
  expect(seen).toEqual(before);
});
