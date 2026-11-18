import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// H16-5: a name must hold a visible character (Luke, 2026-11-18). Core refuses
// a name made only of invisible characters, such as a lone zero-width space,
// as it refuses a blank one, and New document says so. Nothing is made.

const ZWSP = String.fromCodePoint(0x200b);

test('New document refuses a name of only a zero-width space', async ({ page }) => {
  const client = new PlaidClient(CORE, readToken().token);
  const { projectId } = await getFixture();
  const named = async () =>
    (await client.projects.listDocuments(projectId)).filter((d) => d.name === ZWSP);
  expect(await named()).toEqual([]);

  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}`);
  await page.getByRole('button', { name: 'New document' }).click();
  const dialog = page.getByRole('dialog');
  const blank = dialog.getByRole('button', { name: /Blank document/ });
  if (await blank.isVisible()) await blank.click();
  await dialog.locator('#doc-name').fill(ZWSP);
  // The field's own check is JS trim(), which keeps a zero-width space, so the
  // refusal is core's.
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Create' }).click();

  const toast = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: 'Failed to create the document' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Name cannot be blank');
  await expect(dialog.locator('#doc-name')).toBeVisible();
  expect(await named()).toEqual([]);
});
