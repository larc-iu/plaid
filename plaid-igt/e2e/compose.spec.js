import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture } from './fixture.js';

// The composer in a real browser. vitest runs against happy-dom, which has no
// execCommand and so only ever exercises the fallback insert; this is the path
// production actually takes, and the one that keeps the undo stack.

async function openAnalyze(page, projectId, documentId) {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
}

/** Empty the first morpheme form cell and leave the caret in it. */
async function freshCell(page) {
  const cell = page.locator('.igt-island .igt-morph-field').first();
  await cell.click();
  await cell.press('Control+a');
  await cell.press('Delete');
  return cell;
}

test('a backslash code composes in a morpheme form cell', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  const cell = await freshCell(page);
  await page.keyboard.type('k\\swt');
  await expect(cell).toHaveValue('kət');

  // Ordinary words are untouched, which is the whole point of the prefix.
  await cell.press('Control+a');
  await page.keyboard.type('blue');
  await expect(cell).toHaveValue('blue');

  expect.soft(diag.errors, 'no console errors while composing').toEqual([]);
});

test('the insert keeps the browser undo stack', async ({ page }) => {
  // If this passes, execCommand ran. The fallback path sets .value directly,
  // which undo cannot see.
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  const cell = await freshCell(page);
  await page.keyboard.type('ta\\sw');
  await expect(cell).toHaveValue('taə');
  await cell.press('Control+z');
  await expect(cell).not.toHaveValue('taə');
});

test('a code ending in a hyphen composes instead of splitting', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  const cell = await freshCell(page);
  // Count within THIS word only: the fixture document is shared and other
  // specs move morphemes around in it.
  const word = await cell.getAttribute('data-word');
  const inWord = page.locator(`.igt-island .igt-morph-field[data-word="${word}"]`);
  const before = await inWord.count();

  await page.keyboard.type('t\\i-');
  await expect(cell).toHaveValue('tɨ');
  // No new morpheme appeared: the `-` went to the code, not the split.
  expect(await inWord.count()).toBe(before);

  // And a plain hyphen still splits.
  await page.keyboard.type('-');
  await expect.poll(async () => inWord.count()).toBe(before + 1);

  // Put the word back, so the shared fixture does not drift.
  await page.keyboard.press('Backspace');
  await expect.poll(async () => inWord.count()).toBe(before);
});

test('Alt+0 types a zero morph and it round-trips', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  // This one commits, and the fixture project is reused by name across runs,
  // so put the form back at the end.
  const original = await page.locator('.igt-island .igt-morph-field').first().inputValue();
  const cell = await freshCell(page);
  await page.keyboard.press('Alt+0');
  await expect(cell).toHaveValue('∅');
  await cell.press('Tab');
  await page.waitForTimeout(600);

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  const reloaded = page.locator('.igt-island .igt-morph-field').first();
  await expect(reloaded).toHaveValue('∅');

  await reloaded.click();
  await reloaded.press('Control+a');
  await page.keyboard.type(original);
  await reloaded.press('Tab');
  await page.waitForTimeout(600);
  await expect(page.locator('.igt-island .igt-morph-field').first()).toHaveValue(original);
});

test('codes work outside the island too', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Baseline' }).click();

  const area = page.locator('#baseline-text');
  if (!(await area.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /edit/i }).first().click();
  }
  await area.click();
  await area.press('Control+End');
  await page.keyboard.type(' \\ng');
  await expect(area).toHaveValue(/ŋ$/);
});
