import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// Exercises the document editor shell after the IgtDocument unification: tab
// switching is URL state, and each tab, the Details page among them, reads and
// mutates the single shared IgtDocument. Confirms the editor renders and the
// per-tab panels (incl. tokens from doc.sentences) work off the shared model.
test('reactive store drives tab switching and the Details page', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');

  // Tokenized docs auto-open on the Analyze tab, so Details isn't necessarily
  // the default — click into it explicitly, then exercise tab switching from there.
  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();

  // Switch to Baseline — proves docProxy.ui.activeTab mutation triggers a re-render.
  await page.getByRole('tab', { name: 'Baseline' }).click();
  await expect(page.getByRole('heading', { name: 'Baseline text' })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0);

  // Switch to Tokenize — proves the tab renders token pieces from the shared
  // doc.sentences (the fixture has word tokens, so .token spans must appear).
  await page.getByRole('tab', { name: 'Tokenize' }).click();
  await expect(page.getByRole('heading', { name: 'Tokens' })).toBeVisible();
  await expect(page.locator('.token').first()).toBeVisible();

  // Switch to Media — proves DocumentMedia/MediaUpload/useMediaOperations mount
  // off the shared doc without crashing (the most likely media-migration
  // regression). Either face counts: the fixture doc picks up media from a dev
  // session often enough that asserting the upload half made this flaky.
  await page.getByRole('tab', { name: 'Media' }).click();
  await expect(
    page.getByText('Upload media file').or(page.getByText('Timeline', { exact: true })),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible();

  // Details is always editable: the name's Save waits for a change, and the
  // page follows the shared document as it is typed into.
  const name = page.getByLabel('Name', { exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true }).first();
  await expect(save).toBeDisabled();
  await name.fill((await name.inputValue()) + ' x');
  await expect(save).toBeEnabled();
  await name.fill((await name.inputValue()).slice(0, -2));
  await expect(save).toBeDisabled();

  expect.soft(diag.failures, 'no API failures').toEqual([]);
  expect.soft(diag.errors, 'no console errors').toEqual([]);
});
