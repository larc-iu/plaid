import { test, expect } from './fixtures.js';
import { adminClient, buildWorld, dropWorld, signInAs, writesOf } from './vocabHome.js';

// Linking a vocabulary of another project, and ending that borrowing from
// either side (SPEC 5.4, ruling 11.3). The borrowing project's maintainer
// links it from Settings > Text and vocab when they can read its project, and
// unlinks it there. The home's maintainer ends it from the vocabulary's
// Settings, "Used by other projects". Opening either confirm writes nothing:
// the home's asks core what the unlink takes as a dry run, and nothing else.

let world;

test.afterEach(async () => {
  await dropWorld(world);
  world = null;
});

const borrows = async () =>
  ((await adminClient().projects.get(world.B.id)).vocabs || []).some((v) => v.id === world.V.id);

async function openVocabularySettings(page, who) {
  await signInAs(page, who);
  await page.goto(`/#/projects/${world.B.id}/text-and-vocab`);
  await expect(page.getByText(world.V.name, { exact: true })).toBeVisible({ timeout: 15000 });
}

test("a maintainer of the borrowing project who can read the vocabulary's project links it and unlinks it", async ({
  page,
}) => {
  world = await buildWorld({ borrowed: false, roles: { bmr: { B: 'maintainer', A: 'reader' } } });
  await openVocabularySettings(page, 'bmr');
  const row = page.getByRole('row').filter({ hasText: world.V.name });
  await expect(row.getByText(`From “${world.A.name}”.`)).toBeVisible();
  const link = page.getByRole('checkbox', { name: `Link ${world.V.name}` });
  await expect(link).toBeEnabled();
  await link.check();
  await expect.poll(borrows).toBe(true);

  // Unlinking from the borrower: its confirm counts the links with a query and
  // sends no write until Unlink is pressed.
  const seen = writesOf(page);
  await row.getByRole('button', { name: /Unlink/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText(`Unlink vocabulary “${world.V.name}”?`)).toBeVisible();
  await expect(dialog.getByText('This project has no links to its entries.')).toBeVisible();
  // It can link it again, so the dialog does not say otherwise.
  await expect(dialog.getByText('You cannot link it again.')).toHaveCount(0);
  expect(seen.filter((w) => !w.startsWith('POST /api/v1/query'))).toEqual([]);
  await dialog.getByRole('button', { name: 'Unlink' }).click();
  await expect.poll(borrows).toBe(false);
});

test("a maintainer of the borrowing project with no role in the vocabulary's project is told it cannot link it again", async ({
  page,
}) => {
  world = await buildWorld({ roles: { bm: { B: 'maintainer' } } });
  await openVocabularySettings(page, 'bm');
  const row = page.getByRole('row').filter({ hasText: world.V.name });
  await expect(row.getByText('From another project.')).toBeVisible();
  await row.getByRole('button', { name: /Unlink/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('You cannot link it again.')).toBeVisible();
  await expect(dialog.getByText(/This project has 1 link to its entries/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await borrows()).toBe(true);
});

async function openUsedBy(page, who) {
  await signInAs(page, who);
  await page.goto(`/#/vocabularies/${world.V.id}?tab=settings`);
  await expect(page.getByRole('heading', { name: 'Used by other projects' })).toBeVisible({
    timeout: 15000,
  });
}

test("the vocabulary's maintainer ends a borrowing, and opening the confirm only asks what it takes", async ({
  page,
}) => {
  world = await buildWorld({ roles: { hm: { A: 'maintainer' } } });

  // The admin reads B, so it is named and is a link to it.
  await openUsedBy(page, null);
  await expect(page.getByRole('link', { name: world.B.name })).toBeVisible();
  await expect(page.getByRole('button', { name: `Unlink from ${world.B.name}` })).toBeVisible();

  // hm maintains A and has no role in B: "Another project", ended all the same.
  await openUsedBy(page, 'hm');
  await expect(page.getByRole('link', { name: world.B.name })).toHaveCount(0);
  const seen = writesOf(page);
  await page.getByRole('button', { name: 'Unlink from another project' }).click();
  const dialog = page.getByRole('alertdialog');
  // The name is isolated (U+2068, U+2069) inside the title, as names are.
  await expect(
    dialog.getByRole('heading', {
      name: `Unlink “\u2068${world.V.name}\u2069” from another project?`,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      '1 word/morpheme in that project is linked to its entries. Those links will be removed.',
    ),
  ).toBeVisible();
  expect(seen).toEqual([`DELETE /api/v1/projects/${world.B.id}/vocabs/${world.V.id}?dry-run=true`]);
  expect(await borrows()).toBe(true);

  await dialog.getByRole('button', { name: 'Unlink' }).click();
  await expect(page.getByText('No other project uses this vocabulary.')).toBeVisible();
  expect(await borrows()).toBe(false);
  expect(seen.slice(1)).toEqual(['POST /api/v1/batch']);
});
