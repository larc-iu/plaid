import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The "Your last edit" column: it reads the caller's own writes out of the
// audit log, says nothing for a document they have never touched, and costs
// the column rather than the list when the read fails.

const CORE = 'http://localhost:8085';
const ROUTE = '**/audit/last-edits';

let projectId;

test.beforeAll(async () => {
  const client = new PlaidClient(CORE, readToken().token);
  const fixture = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!fixture) throw new Error('run node e2e/fixture.js first');
  projectId = fixture.id;
});

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
});

const open = async (page) => {
  await page.goto(`/#/projects/${projectId}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();
};

// The column's cells, in row order, once the read has settled (no spinners).
const cells = async (page) => {
  const col = page.locator('tbody tr td:nth-child(4)');
  await expect(col.first()).not.toBeEmpty();
  await expect(page.locator('tbody tr td:nth-child(4) .animate-spin')).toHaveCount(0);
  return (await col.allTextContents()).map((t) => t.trim());
};

test('the column shows when this reader last wrote to each document', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('button', { name: 'Your last edit' })).toBeVisible();

  // The fixture is built by this same account, so at least one row has a time.
  const values = await cells(page);
  expect(values.length).toBeGreaterThan(0);
  expect(values.some((v) => v !== '—')).toBe(true);
});

test('a document this reader has never written to says nothing', async ({ page }) => {
  await page.route(ROUTE, (route) => route.fulfill({ json: {} }));
  await open(page);
  const values = await cells(page);
  expect(values.length).toBeGreaterThan(0);
  expect(values.every((v) => v === '—')).toBe(true);
});

test('a failed read costs the column, not the list', async ({ page }) => {
  await page.route(ROUTE, (route) => route.fulfill({ status: 500, json: { error: 'nope' } }));

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await open(page);
  expect((await cells(page)).every((v) => v === '—')).toBe(true);
  // The rows themselves are still there, and nothing threw.
  await expect(page.locator('tbody tr').first().locator('.font-medium')).not.toBeEmpty();
  expect(errors).toEqual([]);
});

test('the column sorts, putting untouched documents last', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Your last edit' }).click(); // ascending
  await page.getByRole('button', { name: 'Your last edit' }).click(); // descending
  const values = await cells(page);
  const firstDash = values.indexOf('—');
  if (firstDash >= 0) {
    expect(values.slice(firstDash).every((v) => v === '—')).toBe(true);
  }
});
