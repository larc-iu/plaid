import { test, expect } from './fixtures.js';
import { adminClient, buildWorld, dropWorld, signInAs } from './vocabHome.js';

// An import makes every vocabulary inside the new project (SPEC 5.4). The
// native archive of a project that borrows a vocabulary carries it like its
// own, and the import makes it a vocabulary of the new project, a copy, while
// the borrowed one stays in its project as it was (ruling 11.5). Exported and
// imported through the screens: a preset on the borrower's Export tab, then
// Import archive.

const FORMAT = 'Plaid IGT JSON (lossless .zip archive)';

let world;
let importedId;

test.afterAll(async () => {
  await dropWorld(world, importedId);
});

test("a borrowed vocabulary comes back from the archive as the new project's own", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  world = await buildWorld();
  const client = adminClient();
  // B has a vocabulary of its own beside the borrowed one.
  const ownName = `VH own ${world.stamp}`;
  const { id: ownId } = await client.vocabLayers.create(world.B.id, ownName);
  await client.vocabItems.create(ownId, 'zorro', { gloss: 'fox' });

  // The archive, from a preset made on B's Export tab.
  await signInAs(page, null);
  await page.goto(`/#/projects/${world.B.id}/export`);
  await page.getByRole('button', { name: 'New preset' }).click();
  await page.locator('#new-preset-format').click();
  await page.getByRole('option', { name: FORMAT, exact: true }).click();
  await expect(page.locator('#new-preset-format')).toContainText(FORMAT);
  await page.locator('#new-preset-name').fill('Archive');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/export\/[^/]+$/);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const archive = testInfo.outputPath('borrower.zip');
  await (await downloading).saveAs(archive);

  // Imported as a new project.
  await page.goto('/#/projects/import-archive');
  await page.locator('input[type="file"]').setInputFiles(archive);
  await expect(page.getByText('2 vocabularies')).toBeVisible({ timeout: 30_000 });
  const name = `VH imported ${world.stamp}`;
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project and import' }).click();
  const openProject = page.getByRole('link', { name: 'Open project' });
  await expect(openProject).toBeVisible({ timeout: 90_000 });
  importedId = (await openProject.getAttribute('href')).split('/').pop();

  // Both vocabularies are the new project's own, made for it.
  const imported = await client.projects.get(importedId);
  const vocabs = (imported.vocabs || []).map((v) => ({ name: v.name, project: v.project }));
  expect(vocabs.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
    [world.V.name, ownName].sort().map((n) => ({ name: n, project: importedId })),
  );
  const ids = imported.vocabs.map((v) => v.id);
  expect(ids).not.toContain(world.V.id);
  expect(ids).not.toContain(ownId);
  const copy = await client.vocabLayers.get(
    imported.vocabs.find((v) => v.name === world.V.name).id,
    true,
  );
  expect(copy.items.map((it) => it.form).sort()).toEqual(['gato', 'kat']);

  // The borrowed vocabulary is still A's, with its entries, and the
  // borrower's own is still B's.
  const original = await client.vocabLayers.get(world.V.id, true);
  expect(original.project).toBe(world.A.id);
  expect(original.items.map((it) => it.form).sort()).toEqual(['gato', 'kat']);
  expect((await client.vocabLayers.get(ownId)).project).toBe(world.B.id);

  // And the new project's settings say so.
  await page.goto(`/#/projects/${importedId}/text-and-vocab`);
  // The admin also sees the original, A's, unlinked here.
  const rows = page.getByRole('row').filter({ hasText: world.V.name });
  const own = rows.filter({ hasText: 'Belongs to this project.' });
  await expect(own).toHaveCount(1, { timeout: 15000 });
  await expect(own.getByRole('checkbox')).toBeDisabled();
  await expect(own.getByRole('checkbox')).toBeChecked();
  await expect(rows.filter({ hasText: `From “${world.A.name}”.` })).toHaveCount(1);
});
