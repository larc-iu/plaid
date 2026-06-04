import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture } from './fixture.js';

// Exercises the morpheme structural keyboard ops in the island as a clean
// round-trip: split a morpheme with '-' (caret mid-string) then merge it back
// with Backspace-at-start. Net-neutral on the fixture. Validates the H1-H4
// mutation-safety fix + that multi-op batches work (non-strict client).

async function openAnalyze(page, projectId, documentId) {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
}

test('split a morpheme with "-" then merge it back', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  const first = page.locator('.igt-morph-field[data-prec="1"]').first();
  const word = await first.getAttribute('data-word');
  const realSel = `.igt-morph-field[data-word="${word}"][data-prec]`;
  const origForm = await first.inputValue();
  const before = await page.locator(realSel).count();

  // Type "ab", move the caret between a and b, split with '-' -> "a" | "b".
  await first.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft'); // caret now between a and b
  await page.keyboard.press('-');
  await expect.poll(() => page.locator(realSel).count(), { timeout: 5000 }).toBe(before + 1);

  // The new morpheme (prec 2, form "b") is focused with caret at start; Backspace
  // merges it back into the previous morpheme.
  await page.keyboard.press('Backspace');
  await expect.poll(() => page.locator(realSel).count(), { timeout: 5000 }).toBe(before);
  await expect(page.locator(`${realSel}`).first()).toHaveValue('ab');

  // Restore the original form so the fixture stays clean for other specs.
  const firstAgain = page.locator('.igt-morph-field[data-prec="1"]').first();
  await firstAgain.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(origForm);
  await firstAgain.press('Enter');
  await page.waitForLoadState('networkidle');

  console.log('--- failed requests ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  console.log('--- console errors ---');
  for (const e of diag.errors) console.log(JSON.stringify(e));
  expect.soft(diag.failures, 'no API failures during structural ops').toEqual([]);
});
