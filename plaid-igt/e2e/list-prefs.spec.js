import { test, expect, seedAuth } from './fixtures.js';
import { getFixture, createScratchProject, makeClient } from './fixtureProject.js';

// A list opens the way it was left: the sort a reader chose survives a reload,
// and it is remembered per project rather than for every list at once. Reads
// "E2E IGT Fixture" and never writes to it.

const sortKey = (id) => `plaid_igt_list_sort:documents:${id}`;

let projectId;
let otherProjectId;

test.beforeAll(async () => {
  ({ projectId } = await getFixture());
  // A second project of its own. It used to take whatever happened to be
  // second on the dev core, which is another session's: it may hold no
  // documents for the list to show, somebody may have sorted it already, and
  // its own spec's afterAll may delete it mid-test.
  ({ projectId: otherProjectId } = await createScratchProject({
    name: `E2E List Prefs ${Date.now()}`,
    docName: 'Second List Document',
    body: 'Uno dos tres.',
  }));
});

test.afterAll(async () => {
  if (!otherProjectId) return;
  await makeClient()
    .projects.delete(otherProjectId)
    .catch((e) => console.error('cleanup failed:', e.message));
});

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
});

const documentHeader = (page) => page.getByRole('button', { name: 'Document', exact: true });

const openDocuments = async (page, id) => {
  await page.goto(`/#/projects/${id}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();
};

// The names down the first column, as the app compares them. Asserting the
// order rather than which row is first keeps the test off whatever documents
// other specs have left in the fixture.
const names = async (page) =>
  (await page.locator('tbody tr .font-medium').allTextContents()).map((n) => n.toLowerCase());

const ascending = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);

test('a chosen sort survives a reload', async ({ page }) => {
  await openDocuments(page, projectId);

  await documentHeader(page).click(); // by name, ascending
  expect(ascending(await names(page))).toBe(true);

  await page.reload();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  expect(ascending(await names(page))).toBe(true);

  // The direction is remembered too, not just the column.
  await documentHeader(page).click();
  const descending = await names(page);
  expect(ascending(descending)).toBe(false);

  await page.reload();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  expect(await names(page)).toEqual(descending);
});

test('the sort is remembered per project, not for every list at once', async ({ page }) => {
  await openDocuments(page, projectId);
  await documentHeader(page).click();

  await openDocuments(page, otherProjectId);
  const stored = await page.evaluate(
    ([a, b]) => [localStorage.getItem(a), localStorage.getItem(b)],
    [sortKey(projectId), sortKey(otherProjectId)],
  );
  expect(JSON.parse(stored[0])).toEqual({ key: 'name', dir: 'asc' });
  expect(JSON.parse(stored[1])).toEqual({ key: 'updated', dir: 'desc' });

  await openDocuments(page, projectId);
  expect(ascending(await names(page))).toBe(true);
});

test('a sort on a column that is gone does not reach the comparator', async ({ page }) => {
  await page.addInitScript(
    ([key]) => {
      localStorage.setItem(key, JSON.stringify({ key: 'a-column-that-was-removed', dir: 'asc' }));
    },
    [sortKey(projectId)],
  );

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await openDocuments(page, projectId);
  await expect(page.locator('tbody tr').first()).toBeVisible();
  expect(errors).toEqual([]);
});
