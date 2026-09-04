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

test('the legend spells the codes correctly', async ({ page }) => {
  // The legend is a lit template literal, where `\sw` is a JS escape, not two
  // characters. Getting this wrong silently prints "sw" and turns `\ng` into a
  // line break, which is exactly what happened once. Only a rendered check
  // catches it.
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  await page.locator('.igt-island .igt-help-btn').click();
  const legend = page.locator('.igt-island .igt-legend');
  await legend.waitFor({ state: 'visible' });
  const text = await legend.innerText();

  for (const code of ['\\sw', '\\ng', '\\?g', '\\00', '\\u0250']) {
    expect(text, `legend should show ${code}`).toContain(code);
  }
  expect(text).toContain('Alt');
  expect(text).toContain('∅');
});

test('every zero-morph code types the same character', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  // The fixture project is shared with every other spec, so put the form back.
  const original = await page.locator('.igt-island .igt-morph-field').first().inputValue();

  for (const code of ['\\00', '\\0/', '\\O|']) {
    const cell = await freshCell(page);
    await page.keyboard.type(code);
    await expect(cell, `${code} should type the zero morph`).toHaveValue('∅');
  }

  // `\0` alone is one character short, so it waits rather than firing. That is
  // what keeps `\0^` and `\0v` reachable.
  const cell = await freshCell(page);
  await page.keyboard.type('\\0');
  await expect(cell).toHaveValue('\\0');
  await page.keyboard.type('^');
  await expect(cell).toHaveValue('\u030A');

  await cell.press('Control+a');
  await page.keyboard.type(original);
  await cell.press('Tab');
  await page.waitForTimeout(600);
  await expect(page.locator('.igt-island .igt-morph-field').first()).toHaveValue(original);
});

test('a code added in Settings works in the grid', async ({ page }) => {
  // The whole point of project-wide configuration, and the part no unit test
  // reaches: Settings writes the config, and the composer has to pick it up in
  // a different screen entirely.
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);

  await page.goto(`/#/projects/${projectId}/text-and-vocab`);
  await page.waitForLoadState('networkidle');
  await page.locator('h2', { hasText: 'Special characters' }).waitFor({ state: 'visible' });

  await page.getByRole('button', { name: 'Add a code' }).click();
  // Typed, never filled: `.fill()` sets the value in one shot and would not
  // notice the row losing focus after the first character.
  await page.locator('[data-code-row=""]').getByLabel('Code', { exact: true }).click();
  await page.keyboard.type("b'");
  // Both characters landed, which they only can if the row kept focus through
  // the first one. The row's data attribute moves as the code is typed, so it
  // is re-located here rather than held from before.
  const row = page.locator(`[data-code-row="b'"]`);
  const codeField = row.getByLabel('Code', { exact: true });
  await expect(codeField).toHaveValue("b'");
  await expect(codeField).toBeFocused();

  const charField = row.locator('input').nth(1);
  await charField.click();
  await page.keyboard.type('ɓ');
  await expect(charField).toBeFocused();
  await page.getByRole('button', { name: 'Save codes' }).click();
  await expect(page.getByRole('button', { name: 'Save codes' })).toBeDisabled();

  await openAnalyze(page, projectId, documentId);
  const cell = await freshCell(page);
  await page.keyboard.type("a\\b'c");
  await expect(cell).toHaveValue('aɓc');

  // A built-in code still works alongside it.
  await cell.press('Control+a');
  await page.keyboard.type('\\sw');
  await expect(cell).toHaveValue('ə');

  // Put the project back.
  await page.goto(`/#/projects/${projectId}/text-and-vocab`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Search codes').fill("b'");
  await page.getByRole('button', { name: "Remove code b'" }).click();
  await page.getByRole('button', { name: 'Save codes' }).click();
  await expect(page.getByRole('button', { name: 'Save codes' })).toBeDisabled();
});

test('a built-in code can be changed and reset', async ({ page }) => {
  // Every built-in is an entry, not a hardcoded fact.
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);

  await page.goto(`/#/projects/${projectId}/text-and-vocab`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Search codes').fill('sw');
  const row = page.locator('[data-code-row="sw"]');
  await row.waitFor({ state: 'visible' });
  // Editing a built-in flips its origin to "changed", which used to remount the
  // row and drop focus on the first keystroke.
  const charField = row.locator('input').first();
  await charField.click();
  await charField.press('Control+a');
  await page.keyboard.type('Ə');
  await expect(charField).toBeFocused();
  await expect(charField).toHaveValue('Ə');
  await expect(row.getByText('Changed')).toBeVisible();
  await page.getByRole('button', { name: 'Save codes' }).click();
  await expect(page.getByRole('button', { name: 'Save codes' })).toBeDisabled();

  await openAnalyze(page, projectId, documentId);
  const cell = await freshCell(page);
  await page.keyboard.type('\\sw');
  await expect(cell).toHaveValue('Ə');

  // Reset puts it back the way it ships.
  await page.goto(`/#/projects/${projectId}/text-and-vocab`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Search codes').fill('sw');
  await page.getByRole('button', { name: 'Reset code sw' }).click();
  await page.getByRole('button', { name: 'Save codes' }).click();
  await expect(page.getByRole('button', { name: 'Save codes' })).toBeDisabled();

  await openAnalyze(page, projectId, documentId);
  const back = await freshCell(page);
  await page.keyboard.type('\\sw');
  await expect(back).toHaveValue('ə');
});
