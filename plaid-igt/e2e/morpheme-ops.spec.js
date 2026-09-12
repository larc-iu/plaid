import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture, makeClient } from './fixtureProject.js';

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

  // Restore the original form so the fixture stays clean for other specs, and
  // CHECK the restore: this spec shares the fixture project, so a restore that
  // silently failed would leave "ab" in it for every spec that runs after.
  const firstAgain = page.locator('.igt-morph-field[data-prec="1"]').first();
  await firstAgain.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(origForm);
  await firstAgain.press('Enter');
  await page.waitForLoadState('networkidle');
  // The SERVER, not the input this test just typed into: that box holds the
  // restored text whether or not the write landed, so asserting on it was a
  // check that could not fail. This spec shares the fixture project, and a
  // silent failure here leaves "ab" in it for every spec that runs after.
  await expect
    .poll(async () => JSON.stringify(await makeClient().documents.get(documentId, true)), {
      timeout: 8000,
    })
    .not.toContain('"form":"ab"');

  console.log('--- failed requests ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  console.log('--- console errors ---');
  for (const e of diag.errors) console.log(JSON.stringify(e));
  expect.soft(diag.failures, 'no API failures during structural ops').toEqual([]);
});

// "=" splits at a clitic boundary and types the outer piece: splitting a
// single-morpheme word at the right edge makes the new piece an enclitic, so
// the joint between the two renders as "=". Merged back afterwards (net-neutral).
test('split a morpheme with "=" types an enclitic, then merge it back', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  const first = page.locator('.igt-morph-field[data-prec="1"]').first();
  const word = await first.getAttribute('data-word');
  const realSel = `.igt-morph-field[data-word="${word}"][data-prec]`;
  const joinerSel = `.igt-morph-field[data-word="${word}"]`;
  const origForm = await first.inputValue();
  const before = await page.locator(realSel).count();

  await first.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('=');
  await expect.poll(() => page.locator(realSel).count(), { timeout: 5000 }).toBe(before + 1);
  // The joint between the pieces renders "=" because the new piece is an enclitic.
  const col = page
    .locator(joinerSel)
    .first()
    .locator('xpath=ancestor::div[contains(@class,"igt-morphemes")]');
  await expect(col.locator('.igt-morph-joiner').first()).toHaveText('=');

  // Merge back and restore the original form.
  await page.keyboard.press('Backspace');
  await expect.poll(() => page.locator(realSel).count(), { timeout: 5000 }).toBe(before);
  await expect(page.locator(realSel).first()).toHaveValue('ab');
  const firstAgain = page.locator('.igt-morph-field[data-prec="1"]').first();
  await firstAgain.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(origForm);
  await firstAgain.press('Enter');
  await page.waitForLoadState('networkidle');
  // See the note in the first test: the input is not evidence.
  await expect
    .poll(async () => JSON.stringify(await makeClient().documents.get(documentId, true)), {
      timeout: 8000,
    })
    .not.toContain('"form":"ab"');

  expect.soft(diag.failures, 'no API failures during "=" split').toEqual([]);
});
