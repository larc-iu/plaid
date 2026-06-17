import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { getFixture } from './fixture.js';

// Exercises the document editor shell after the IgtDocument unification: tab
// switching is React-local state, and each tab + the metadata Edit toggle read/
// mutate the single shared IgtDocument. Confirms the editor renders and the
// per-tab panels (incl. tokens from doc.sentences) work off the shared model.
test('reactive store drives tab switching + metadata edit toggle', async ({ page }) => {
  const { projectId, documentId } = await getFixture();
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}`);
  await page.waitForLoadState('networkidle');

  // Tokenized docs auto-open on the Analyze tab, so Metadata isn't necessarily
  // the default — click into it explicitly, then exercise tab switching from there.
  await page.getByRole('tab', { name: 'Metadata' }).click();
  await expect(page.getByRole('heading', { name: 'Document Information' })).toBeVisible();

  // Switch to Baseline — proves docProxy.ui.activeTab mutation triggers a re-render.
  await page.getByRole('tab', { name: 'Baseline' }).click();
  await expect(page.getByRole('heading', { name: 'Baseline Text' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Document Information' })).toHaveCount(0);

  // Switch to Tokenize — proves the tab renders token pieces from the shared
  // doc.sentences (the fixture has word tokens, so .token spans must appear).
  await page.getByRole('tab', { name: 'Tokenize' }).click();
  await expect(page.getByRole('heading', { name: 'Tokens' })).toBeVisible();
  await expect(page.locator('.token').first()).toBeVisible();

  // Switch to Media — the fixture doc has no media, so the upload UI must render.
  // Proves DocumentMedia/MediaUpload/useMediaOperations mount off the shared doc
  // without crashing (the most likely media-migration regression).
  await page.getByRole('tab', { name: 'Media' }).click();
  await expect(page.getByText('Upload Media File')).toBeVisible();

  await page.getByRole('tab', { name: 'Metadata' }).click();
  await expect(page.getByRole('heading', { name: 'Document Information' })).toBeVisible();

  // Toggle metadata edit mode — mutates docProxy.ui.metadata.isEditing; the edit
  // form (Save Changes / Cancel buttons) only appears if the store re-renders.
  await page.getByRole('button', { name: /Edit/ }).click();
  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Cancel/ })).toBeVisible();

  expect.soft(diag.failures, 'no API failures').toEqual([]);
  expect.soft(diag.errors, 'no console errors').toEqual([]);
});
