import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture, makeClient } from './fixtureProject.js';

// The composer in a real browser. vitest runs against happy-dom, which has no
// execCommand and so only ever exercises the fallback insert; this is the path
// production actually takes, and the one that keeps the undo stack.

async function openAnalyze(page, projectId, documentId) {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
}

// The same, but reading the SERVER again.
//
// A `goto` to a URL that differs only in the fragment is a same-document
// navigation, and this app is a hash router, so going "back" to a document it
// already has loaded keeps the IgtDocument in memory, typed-in values and all.
// Anything that has to prove a value reached the server reloads.
async function reloadAnalyze(page, projectId, documentId) {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.reload();
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

// Put the first morpheme's form back. The fixture document is shared and reused
// by name across runs, so a test that commits into it has to, and a navigation
// away from the grid commits whatever is in the cell.
//
// Through the client, not by typing: what is seeded is a morpheme with NO form
// of its own, whose text comes from the word underneath. Typing "Todos" back
// into the cell writes metadata.form = "Todos", which looks identical on screen
// and is not the same thing, and e2e/scripts/reset-fixture.mjs would report the
// fixture as drifted after every run.
//
// The check is made after a reload, because the box this spec typed into holds
// whatever it was given whether or not the write landed.
async function restoreForm(page, projectId, documentId) {
  const client = makeClient();
  const firstMorpheme = async () => {
    const raw = await client.documents.get(documentId, true);
    const text = raw.textLayers[0];
    const morphemes = text.tokenLayers.find((l) => l.config?.plaid?.role === 'morpheme');
    const token = morphemes.tokens
      .slice()
      .sort((a, b) => a.begin - b.begin || (a.precedence ?? 0) - (b.precedence ?? 0))[0];
    return { token, seeded: text.text.body.slice(token.begin, token.end) };
  };

  // Whatever the test typed is still sitting in the cell, and leaving the grid
  // blurs it, which commits. Let that land FIRST: a clear made before it is
  // simply overwritten by it, which is how "Ə" survived three restores.
  await reloadAnalyze(page, projectId, documentId);

  const { token, seeded } = await firstMorpheme();
  await client.tokens.patchMetadata(token.id, { form: null });
  // The clear is checked on the server, not on the screen: a commit still in
  // flight would put the form back after it, and this is the assertion that
  // goes red rather than the next spec that trips over the residue.
  await expect
    .poll(async () => (await firstMorpheme()).token.metadata?.form, { timeout: 8000 })
    .toBeUndefined();

  await reloadAnalyze(page, projectId, documentId);
  await expect(page.locator('.igt-island .igt-morph-field').first()).toHaveValue(seeded);
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

  // Put the word back, so the shared fixture does not drift. The count AND the
  // form: a merge leaves the typed text in the morpheme it merged into, which
  // is what every later spec then reads as the word's form.
  await page.keyboard.press('Backspace');
  await expect.poll(async () => inWord.count()).toBe(before);
  await restoreForm(page, projectId, documentId);
});

test('Alt+0 types a zero morph and it round-trips', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await openAnalyze(page, projectId, documentId);

  // This one commits, and the fixture project is reused by name across runs,
  // so put the form back at the end.
  const cell = await freshCell(page);
  await page.keyboard.press('Alt+0');
  await expect(cell).toHaveValue('∅');
  await cell.press('Tab');
  // The commit is a write, and the reload below must not race it.
  await page.waitForLoadState('networkidle');

  await reloadAnalyze(page, projectId, documentId);
  await expect(page.locator('.igt-island .igt-morph-field').first()).toHaveValue('∅');

  await restoreForm(page, projectId, documentId);
});

test('codes work outside the island too', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Baseline' }).click();

  const area = page.locator('#baseline-text');
  const edit = page.getByRole('button', { name: /edit/i }).first();
  // One or the other: an empty document opens straight into the editor, and one
  // with text waits behind Edit. Waiting for whichever arrives first is what
  // makes the branch below a branch rather than a race: a bare `isVisible()`
  // read while the tab is still rendering answers "no" and clicks a button that
  // is not there either.
  await area.or(edit).first().waitFor();
  if (!(await area.isVisible())) await edit.click();
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

  await restoreForm(page, projectId, documentId);
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
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await openAnalyze(page, projectId, documentId);
  const cell = await freshCell(page);
  await page.keyboard.type("a\\b'c");
  await expect(cell).toHaveValue('aɓc');

  // A built-in code still works alongside it.
  await cell.press('Control+a');
  await page.keyboard.type('\\sw');
  await expect(cell).toHaveValue('ə');

  // Put the project back, and the document with it: leaving the grid for the
  // settings page blurs the cell, and a blur is a commit.
  await page.goto(`/#/projects/${projectId}/text-and-vocab`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Search codes').fill("b'");
  await page.getByRole('button', { name: "Remove code b'" }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await restoreForm(page, projectId, documentId);
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
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await openAnalyze(page, projectId, documentId);
  const cell = await freshCell(page);
  await page.keyboard.type('\\sw');
  await expect(cell).toHaveValue('Ə');

  // Reset puts it back the way it ships.
  await page.goto(`/#/projects/${projectId}/text-and-vocab`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Search codes').fill('sw');
  await page.getByRole('button', { name: 'Reset code sw' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await openAnalyze(page, projectId, documentId);
  const back = await freshCell(page);
  await page.keyboard.type('\\sw');
  await expect(back).toHaveValue('ə');

  // Leaving the grid for the settings page above committed the changed code's
  // output as the morpheme's form, so the document needs putting back too.
  await restoreForm(page, projectId, documentId);
});
