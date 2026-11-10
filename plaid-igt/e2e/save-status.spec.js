import { test, expect, seedAuth } from './fixtures.js';
import { createScratchProject, makeClient } from './fixtureProject.js';

// The save status beside the tabs. The Analyze grid shows a save pill of its
// own, so the tab row shows the shell's status on every other tab and none on
// Analyze: one status on screen whichever tab is open. A save the server has
// not answered after 3 s reads "Saving…" there until it lands. A throwaway
// project, deleted afterwards.

let projectId;
let documentId;

test.beforeAll(async () => {
  ({ projectId, documentId } = await createScratchProject({
    name: `E2E save status ${Date.now()}`,
    docName: 'Save status',
    body: 'nis kawa',
  }));
});

test.afterAll(async () => {
  if (projectId)
    await makeClient()
      .projects.delete(projectId)
      .catch(() => {});
});

// The shell's status, apart from the Analyze grid's own pill.
const tabRowStatus = (page) => page.locator('[role="status"][data-state]:not(.igt-status)');

// Holds every write the page sends until the function it answers is called.
async function holdWrites(page) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    const write = req.method() !== 'GET' && !/\/(query|login)(\?|$)/.test(req.url());
    if (write) await gate;
    await route.continue().catch(() => {});
  });
  return () => release();
}

test('a held save on Details reads Saving… beside the tabs until it lands', async ({ page }) => {
  test.setTimeout(60_000);
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=details`);
  const name = page.locator('#document-name');
  await expect(name).toBeEnabled({ timeout: 20_000 });
  await expect(tabRowStatus(page)).toHaveCount(1);
  const release = await holdWrites(page);
  await name.fill(`Renamed ${Date.now()}`);
  await name.press('Enter');
  await page.waitForTimeout(1000);
  await expect(tabRowStatus(page)).toHaveText('');
  await expect(tabRowStatus(page)).toHaveText('Saving…', { timeout: 4000 });
  release();
  await expect(tabRowStatus(page)).toHaveText('', { timeout: 10_000 });
});

test('Analyze shows its own pill and no status beside the tabs', async ({ page }) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);
  await expect(page.locator('.igt-status')).toHaveCount(1, { timeout: 20_000 });
  await expect(tabRowStatus(page)).toHaveCount(0);
  await page.getByRole('tab', { name: 'Baseline' }).click();
  await expect(tabRowStatus(page)).toHaveCount(1);
  await expect(page.locator('.igt-status')).toHaveCount(0);
});
