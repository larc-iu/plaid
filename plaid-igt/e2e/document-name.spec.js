import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// H16-5, REV-RL2-4: a name must hold a visible character (Luke, 2026-11-18).
// New document takes a name of only a zero-width space as none, as it takes
// one of only spaces: Create stays disabled. Core refuses such a name too, for
// any other sender, with the words of a blank one. Nothing is made.

const ZWSP = String.fromCodePoint(0x200b);

test('New document takes a name of only a zero-width space as none', async ({ page }) => {
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
  const field = dialog.locator('#doc-name');
  const create = dialog.getByRole('button', { name: 'Create' });
  for (const name of ['   ', ZWSP]) {
    await field.fill(name);
    await expect(create).toBeDisabled();
    await field.press('Enter');
  }
  await field.fill(`a${ZWSP}`);
  await expect(create).toBeEnabled();

  const refused = await client.documents.create(projectId, ZWSP).catch((e) => e);
  expect(refused.status).toBe(400);
  expect(refused.message).toContain('Name cannot be blank');
  expect(await named()).toEqual([]);
});
