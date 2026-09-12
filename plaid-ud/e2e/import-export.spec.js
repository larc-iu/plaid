import { test, expect, seedAuth } from './fixtures.js';
import { PlaidClient } from '@larc-iu/plaid-client';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { createUdProject } from '../src/domain/udProjectSetup.js';

// Smoke for the four-tab project page + bulk CoNLL-U import (with `# newdoc id`
// splitting and per-document reject reporting) + project-wide ZIP export.
// Drives the real React UI against the live core.
//
// It SEEDS ITS OWN project and deletes it. It used to import into the first
// UD-configured project on the server, which on a dev box is whatever someone
// is working in: here that is the 1172-document EWT treebank. `e2e/README.md`
// asks a spec to seed and delete its own or leave the shared fixture alone,
// and this did neither, with a name-prefix cleanup inside a swallowed catch.

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const NAME_PREFIX = 'e2e_imp_';
let PID;
let client;

test.beforeAll(async () => {
  client = await PlaidClient.login('http://localhost:8085', 'a@b.com', 'password');
  // The same function the New Project modal calls, so the layers are the ones
  // a real project has.
  const project = await createUdProject(client, `${NAME_PREFIX}${Date.now()}`);
  PID = project.id;
  if (!getUdLayerInfo(await client.projects.get(PID)).isConfigured) {
    throw new Error('the seeded project did not come back configured for UD');
  }
});

test.afterAll(async () => {
  // The whole project goes, so there is nothing to leave behind. A swallowed
  // failure here is still worth seeing: litter is what made `search.spec.js`
  // fail a day ago.
  try {
    if (PID) await client.projects.delete(PID);
  } catch (e) {
    console.error('cleanup failed:', e.message);
  }
});

test('four tabs, bulk import (newdoc split + reject), and zip export', async ({ page }) => {
  expect(PID, 'a UD-configured project must exist').toBeTruthy();
  await seedAuth(page);

  // --- The four project tabs render on the Documents page ---
  await page.goto(`${BASE}/#/projects/${PID}/documents`);
  for (const name of ['Documents', 'Search', 'Project Settings', 'Import & Export']) {
    await expect(page.getByRole('tab', { name })).toBeVisible();
  }

  // --- Project Settings has a link-list nav down the left ---
  await page.getByRole('tab', { name: 'Project Settings' }).click();
  await expect(page).toHaveURL(/management/);
  await expect(page.getByRole('link', { name: 'UD Customization' })).toBeVisible();

  // --- Import / Export tab ---
  await page.getByRole('tab', { name: 'Import & Export' }).click();
  await expect(page).toHaveURL(/import-export/);
  await expect(page.getByText(/Drop .* files here/i)).toBeVisible();

  // One valid file with TWO `# newdoc id` blocks (=> 2 documents), plus one
  // malformed file (=> 1 rejected).
  const ts = Date.now();
  const id1 = `${NAME_PREFIX}${ts}_a`;
  const id2 = `${NAME_PREFIX}${ts}_b`;
  const good =
    `# newdoc id = ${id1}\n# text = Hi there\n` +
    `1\tHi\t_\t_\t_\t_\t0\troot\t_\t_\n2\tthere\t_\t_\t_\t_\t1\tdep\t_\t_\n\n` +
    `# newdoc id = ${id2}\n# text = Bye now\n` +
    `1\tBye\t_\t_\t_\t_\t0\troot\t_\t_\n2\tnow\t_\t_\t_\t_\t1\tdep\t_\t_\n`;
  const bad = `this is not conllu\n1 2 3\n`;

  await page.locator('input[type=file]').setInputFiles([
    { name: `${NAME_PREFIX}good.conllu`, mimeType: 'text/plain', buffer: Buffer.from(good) },
    { name: `${NAME_PREFIX}bad.conllu`, mimeType: 'text/plain', buffer: Buffer.from(bad) },
  ]);
  await expect(page.getByText(/2 files queued/)).toBeVisible();

  await page.getByRole('button', { name: /^Import/ }).click();

  // 2 of the 3 resulting documents import (both newdoc blocks); the malformed
  // file is rejected.
  await expect(page.getByText(/Imported 2 of 3/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(id1, { exact: true })).toBeVisible();
  await expect(page.getByText(id2, { exact: true })).toBeVisible();

  // --- Project-wide export downloads a .zip ---
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
});
