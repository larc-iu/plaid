import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The admin area, which had no coverage at all until the two bugs below got
// through: a table that forgot to name itself and so remembered nothing, and
// an empty list that drew a bar saying "0". Both were found by opening the
// page and looking, which is not a thing that happens on every change.
//
// Writes nothing. Every assertion is about what the server already holds.

let fixtureId;

test.beforeAll(async () => {
  const client = new PlaidClient('http://localhost:8085', readToken().token);
  const projects = await client.projects.list();
  fixtureId = projects.find((p) => p.name === 'E2E IGT Fixture')?.id;
  if (!fixtureId) throw new Error('run node e2e/fixture.js first');
});

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
});

const TABS = [
  'users',
  'invites',
  'activity',
  'projects',
  'vocabularies',
  'services',
  'assistant',
  'server',
];

const openTab = async (page, tab) => {
  await page.goto(`/#/admin?tab=${tab}`);
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
};

test('every tab renders, and none of them reports an error', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  for (const tab of TABS) {
    await openTab(page, tab);
    // The panel has to draw SOMETHING: a table, or the sentence a panel shows
    // when it legitimately holds nothing. Asserting on text length rather than
    // on a particular element keeps this from caring which of the two it is.
    const panel = page.getByRole('tabpanel');
    await expect
      .poll(async () => (await panel.innerText()).replace(/Loading…/g, '').trim().length, {
        timeout: 20000,
      })
      .toBeGreaterThan(20);
  }

  expect(errors).toEqual([]);
});

test('every table names itself, so its column order is remembered', async ({ page }) => {
  // The Server tab shipped two tables with no id, which silently meant no
  // memory. The component says so on the console in dev, so a page that draws
  // a table without one is a failure here.
  const complaints = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('DataTable')) complaints.push(msg.text());
  });

  for (const tab of TABS) {
    await openTab(page, tab);
    await page.waitForTimeout(500);
  }

  expect(complaints).toEqual([]);
});

test('a chosen order survives leaving the page and coming back', async ({ page }) => {
  await openTab(page, 'projects');
  const nameHeader = page.getByRole('button', { name: 'Name', exact: true });
  await expect(nameHeader).toBeVisible();

  const names = async () =>
    (await page.locator('tbody tr td:first-child').allTextContents()).map((n) => n.trim());

  const initial = await names();
  expect(initial.length).toBeGreaterThan(1);

  await nameHeader.click();
  const ascending = await names();
  // The click has to have done something, or remembering it proves nothing.
  expect(ascending).not.toEqual(initial);

  // Leave the admin area entirely, then return.
  await page.goto('/#/projects');
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await openTab(page, 'projects');
  await expect(page.locator('tbody tr').first()).toBeVisible();

  expect(await names()).toEqual(ascending);
});

test('a blank sorts as the smallest value, not pinned to the bottom', async ({ page }) => {
  // Projects nobody has touched read "Never" under Last change. Ascending they
  // come first, because never IS the oldest, and descending they go last.
  await openTab(page, 'projects');
  const header = page.getByRole('button', { name: 'Last change' });
  await expect(header).toBeVisible();

  const lastChange = async () =>
    (await page.locator('tbody tr td:nth-child(5)').allTextContents()).map((s) => s.trim());

  await header.click();
  const first = await lastChange();
  test.skip(!first.includes('Never'), 'no untouched project in this database');
  expect(first[0]).toBe('Never');

  await header.click();
  const flipped = await lastChange();
  expect(flipped[flipped.length - 1]).toBe('Never');
  expect(flipped[0]).not.toBe('Never');
});

test('an empty list says so once, without a bar saying zero', async ({ page }) => {
  // "0 links" above "No invitation links yet." is the empty state twice. This
  // has to run against a list with no title, search or actions of its own,
  // because a table with any of those draws its bar regardless and the bug
  // cannot show. The fixture project's invitation links are that list.
  await page.goto(`/#/projects/${fixtureId}/access`);
  await expect(page.getByText('No invitation links yet.')).toBeVisible({ timeout: 15000 });
  // Plain string, not a regex with \b: the match runs against textContent,
  // which concatenates without separators ("New link0 links"), so a word
  // boundary before the zero never holds and the assertion could never fail.
  await expect(page.locator('body')).not.toContainText('0 links');
});

test('services collapse to one row per service, with its projects underneath', async ({ page }) => {
  await openTab(page, 'services');
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 20000 });

  const expanders = page.getByRole('button', { name: 'Expand' });
  const count = await expanders.count();
  test.skip(count === 0, 'no services registered in this database');

  // A registration is keyed (project, service id), so the row has to stand for
  // more than itself: opening it reveals the projects behind the count.
  const before = await rows.count();
  await expanders.first().click();
  await expect(page.locator('tbody td[colspan]').first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(before);
});

test('an assistant conversation opens whoever had it', async ({ page }) => {
  // Conversations live in their owner's private store, so this screen is the
  // only place one can be read by anyone else. Opening one has to produce the
  // transcript, not just the row it came from.
  await openTab(page, 'assistant');
  const rows = page.locator('tbody tr');
  await expect(page.getByPlaceholder('Search conversations…')).toBeVisible({ timeout: 20000 });

  const count = await rows.count();
  test.skip(count === 0, 'no assistant conversations in this database');

  const title = (await rows.first().locator('td').first().innerText()).trim();
  await rows.first().locator('button').first().click();

  await expect(page.getByRole('button', { name: 'All conversations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
  // Rendered as the conversation, not as the record: both sides are named.
  // `exact`, because getByRole matches the accessible name by SUBSTRING, and
  // the title heading right above happened to contain the word "you" — so
  // without it this passed against a transcript that rendered nothing at all.
  const speaker = (name) =>
    page.locator('.prose').getByRole('heading', { name, exact: true, level: 2 });
  await expect(speaker('You').first()).toBeVisible({ timeout: 15000 });
  await expect(speaker('Assistant').first()).toBeVisible();
});

test('the activity feed reads newest first and can be searched', async ({ page }) => {
  await openTab(page, 'activity');
  const search = page.getByPlaceholder('Search changes…');
  await expect(search).toBeVisible({ timeout: 20000 });

  const feedRows = () => page.locator('table').last().locator('tbody tr');
  const before = await feedRows().count();
  test.skip(before === 0, 'no audit history in this database');

  await search.fill('zzzznotathing');
  await expect(page.getByText(/No changes match/)).toBeVisible();

  await search.fill('');
  await expect(feedRows().first()).toBeVisible();
});
