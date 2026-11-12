import { test, expect } from './fixtures.js';
import { adminClient, asksOf, buildWorld, dropWorld, signInAs, writesOf } from './vocabHome.js';

// Deleting a vocabulary, or the project it belongs to, is refused while
// another project uses it, for everyone, the admin included (ruling 11.2).
// Each confirm asks core first, with a GET of what the delete would take
// (never the DELETE), and shows the refusal with
// Cancel only. Once the borrowing ends, both deletes go through, and the
// project's delete takes its vocabulary with it.

let world;

test.afterEach(async () => {
  await dropWorld(world);
  world = null;
});

const endBorrowing = () => adminClient().projects.unlinkVocab(world.B.id, world.V.id);
const gone = (read) =>
  read.then(
    () => false,
    () => true,
  );

test('a vocabulary another project uses is not deleted, and is once that project unlinks it', async ({
  page,
}) => {
  world = await buildWorld();
  await signInAs(page, null);
  await page.goto(`/#/vocabularies/${world.V.id}?tab=settings`);
  const open = page.getByRole('button', { name: 'Delete vocabulary' });
  await expect(open).toBeVisible({ timeout: 15000 });

  const seen = writesOf(page);
  const asked = asksOf(page);
  await open.click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText(
      '1 other project uses this vocabulary. Unlink it from that project under Used by other projects first.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('button')).toHaveText(['Cancel', 'Close']);
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  expect(asked).toEqual([`GET /api/v1/vocab-layers/${world.V.id}/deletion`]);
  expect(seen).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await endBorrowing();
  seen.length = 0;
  asked.length = 0;
  await open.click();
  await expect(
    dialog.getByText(`Deletes “${world.V.name}” with all its entries and their links.`, {
      exact: false,
    }),
  ).toBeVisible();
  // A's "kat" is the one link left.
  await expect(dialog.getByText(/Its entries are linked to\s*1 word\/morpheme/)).toBeVisible();
  expect(asked).toEqual([`GET /api/v1/vocab-layers/${world.V.id}/deletion`]);
  expect(seen).toEqual([]);
  await dialog.getByRole('textbox').fill(world.V.name);
  await dialog.getByRole('button', { name: 'Delete vocabulary' }).click();
  await expect.poll(() => gone(adminClient().vocabLayers.get(world.V.id))).toBe(true);
  // The delete goes in a batch, beside the reads that count what it takes.
  expect(seen.filter((w) => !w.startsWith('POST /api/v1/query'))).toEqual(['POST /api/v1/batch']);
});

test('a project whose vocabulary another project uses is not deleted, and is once that project unlinks it', async ({
  page,
}) => {
  world = await buildWorld();
  await signInAs(page, null);
  await page.goto(`/#/projects/${world.A.id}/general`);
  const open = page.getByRole('button', { name: 'Delete project' });
  await expect(open).toBeVisible({ timeout: 15000 });

  const seen = writesOf(page);
  const asked = asksOf(page);
  await open.click();
  const dialog = page.getByRole('alertdialog');
  await expect(
    dialog.getByText(
      '1 other project uses a vocabulary of this project. It can be deleted once that project unlinks it.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('button')).toHaveText(['Cancel']);
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  expect(asked).toEqual([`GET /api/v1/projects/${world.A.id}/deletion`]);
  expect(seen).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await endBorrowing();
  seen.length = 0;
  asked.length = 0;
  await open.click();
  await expect(
    dialog.getByText(`Its vocabulary “${world.V.name}” is deleted with it.`),
  ).toBeVisible();
  expect(asked).toEqual([`GET /api/v1/projects/${world.A.id}/deletion`]);
  expect(seen).toEqual([]);
  await dialog.getByRole('textbox').fill(world.A.name);
  await dialog.getByRole('button', { name: 'Delete project' }).click();
  await expect.poll(() => gone(adminClient().projects.get(world.A.id))).toBe(true);
  expect(await gone(adminClient().vocabLayers.get(world.V.id))).toBe(true);
  expect(seen).toEqual([`DELETE /api/v1/projects/${world.A.id}`]);
  world.A.id = null;
});
