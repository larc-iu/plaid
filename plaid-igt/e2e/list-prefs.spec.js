import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// A list opens the way it was left: the sort a reader chose survives a reload,
// and it is remembered per project rather than for every list at once. Runs
// against "E2E IGT Fixture" and writes nothing to the server.

const CORE = 'http://localhost:8085';
const sortKey = (id) => `plaid_igt_list_sort:documents:${id}`;

let projectId;
let otherProjectId;

test.beforeAll(async () => {
  const client = new PlaidClient(CORE, readToken().token);
  const projects = await client.projects.list();
  const fixture = projects.find((p) => p.name === 'E2E IGT Fixture');
  if (!fixture) throw new Error('run node e2e/fixture.js first');
  projectId = fixture.id;
  otherProjectId = projects.find((p) => p.id !== projectId)?.id;
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
  test.skip(!otherProjectId, 'needs a second project on this server');

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
