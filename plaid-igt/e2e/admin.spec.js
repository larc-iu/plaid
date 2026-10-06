import { randomUUID } from 'node:crypto';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture, makeClient } from './fixtureProject.js';

// The admin area, which had no coverage at all until the two bugs below got
// through: a table that forgot to name itself and so remembered nothing, and
// an empty list that drew a bar saying "0". Both were found by opening the
// page and looking, which is not a thing that happens on every change.
//
// What the screens need is seeded here, so a fresh database passes too: a
// project with no documents (it reads "Never" and is a second project to sort
// and to register on), a probe service registered on two projects while its
// test runs, and one assistant conversation. Each is found or made, and the
// service and the conversation are removed again afterwards.

// A project nobody adds a document to, so its last change is "Never".
const UNTOUCHED = 'E2E Admin Untouched';
const PROBE = { serviceId: 'e2e:admin-probe', serviceName: 'E2E admin probe' };

let client;
let fixtureId;
let untouchedId;
let conversation; // {userId, keys: [...]}, removed in afterAll

test.beforeAll(async () => {
  client = makeClient();
  ({ projectId: fixtureId } = await getFixture());
  const projects = await client.projects.list();
  untouchedId =
    projects.find((p) => p.name === UNTOUCHED)?.id ?? (await client.projects.create(UNTOUCHED)).id;
});

test.afterAll(async () => {
  if (conversation) {
    for (const k of conversation.keys) {
      await client.userData.delete(conversation.userId, k).catch(() => {});
    }
  }
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
  'logs',
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
    //
    // The budget is generous because Server is: it waits on a COUNT(*) per
    // table, so it takes as long as the database is big (14s against a 13GB
    // one with 10.9M audit rows). This test is here to catch a tab that draws
    // nothing or throws, not to police that.
    const panel = page.getByRole('tabpanel');
    await expect
      .poll(async () => (await panel.innerText()).replace(/Loading…/g, '').trim().length, {
        timeout: 60000,
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

  // The chosen order has to differ from the opening one (newest change
  // first), or remembering it proves nothing. When A to Z reads the same,
  // Z to A is chosen instead.
  await nameHeader.click();
  let chosen = await names();
  if (chosen.join('\n') === initial.join('\n')) {
    await nameHeader.click();
    await expect.poll(names).not.toEqual(initial);
    chosen = await names();
  }

  // Leave the admin area entirely, then return.
  await page.goto('/#/projects');
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await openTab(page, 'projects');
  await expect(page.locator('tbody tr').first()).toBeVisible();

  // The dev core is shared: another suite may have made or deleted a project
  // meanwhile. What must hold is the order of the names in both readings.
  const after = await names();
  const inBoth = (a, b) => a.filter((n) => b.includes(n));
  expect(inBoth(after, chosen)).toEqual(inBoth(chosen, after));
  expect(inBoth(after, chosen).length).toBeGreaterThan(1);
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
  expect(first, 'the untouched project reads Never').toContain('Never');
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
  // One service id registered on two projects is two registrations and one
  // row. Registered from here for the length of the test, so the row exists
  // on a database no service has ever connected to.
  const registrations = [fixtureId, untouchedId].map((projectId) =>
    client.messages.serve(projectId, PROBE, (_data, helper) => helper.error('not served'), {
      tasks: [],
    }),
  );
  const onlineOn = async (projectId) =>
    (await client.messages.discoverServices(projectId)).some(
      (s) => s.serviceId === PROBE.serviceId && s.online,
    );
  try {
    await expect.poll(() => onlineOn(fixtureId), { timeout: 15000 }).toBe(true);
    await expect.poll(() => onlineOn(untouchedId), { timeout: 15000 }).toBe(true);

    await openTab(page, 'services');
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 20000 });

    const probe = rows.filter({ hasText: PROBE.serviceName });
    await expect(probe).toHaveCount(1);
    await expect(probe).toContainText('2 of 2');

    // A registration is keyed (project, service id), so the row has to stand for
    // more than itself: opening it reveals the projects behind the count.
    const before = await rows.count();
    await probe.getByRole('button', { name: 'Expand' }).click();
    const detail = page.locator('tbody td[colspan]');
    await expect(detail.first()).toBeVisible();
    await expect(detail.getByText(UNTOUCHED)).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(before);
  } finally {
    registrations.forEach((r) => r.stop());
    // Forgotten once the channel is closed (a live one is refused, 409), so
    // no offline row is left behind on either project.
    for (const projectId of [fixtureId, untouchedId]) {
      await expect
        .poll(
          () =>
            client.messages.discardService(projectId, PROBE.serviceId).then(
              () => true,
              () => false,
            ),
          { timeout: 30000 },
        )
        .toBe(true);
    }
  }
});

test('an assistant conversation opens whoever had it', async ({ page }) => {
  // Conversations live in their owner's private store, so this screen is the
  // only place one can be read by anyone else. Opening one has to produce the
  // transcript, not just the row it came from.
  //
  // One is seeded the way the assistant service writes one: a sidebar entry
  // (meta) and a transcript (conv) under the owner's key/value store.
  const { userId } = readToken();
  const id = randomUUID();
  const title = `E2E admin conversation ${id.slice(0, 8)}`;
  const key = (kind) => `igt:assistant:${fixtureId}:${kind}:${id}`;
  conversation = { userId, keys: [key('conv'), key('meta')] };
  await client.userData.put(userId, key('conv'), {
    messages: [
      { role: 'user', content: 'How many documents are there?' },
      { role: 'assistant', content: 'There is one.' },
    ],
    display: [
      { kind: 'user', text: 'How many documents are there?' },
      { kind: 'assistant', text: 'There is one.', citations: [], status: null, steps: [] },
    ],
  });
  const now = new Date().toISOString();
  await client.userData.put(userId, key('meta'), {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    serviceId: 'igt:assist:e2e',
    model: 'e2e/model',
    turns: 1,
    pending: null,
  });

  await openTab(page, 'assistant');
  const rows = page.locator('tbody tr');
  await expect(page.getByPlaceholder('Search conversations…')).toBeVisible({ timeout: 20000 });

  // The only coverage of item 13.3, the admin conversation index, so a skip
  // here leaves that feature untested and says it passed. Narrowed to the
  // seeded one, since a dev database holds everyone's.
  await page.getByPlaceholder('Search conversations…').fill(title);
  //
  // Polled, not counted once: the toolbar and its search box render before the
  // rows do, and `count()` does not retry, so taking it the moment the
  // placeholder appeared read zero about one run in four.
  await expect
    .poll(() => rows.count(), {
      timeout: 20000,
      message: 'the seeded conversation should be listed',
    })
    .toBeGreaterThan(0);

  await expect(rows.first().locator('td').first()).toHaveText(title);
  await rows.first().locator('button').first().click();

  await expect(page.getByRole('button', { name: 'All conversations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
  // Rendered as the conversation, as the chat draws it: the question and the
  // reply each show, with no way to answer or approve from here.
  await expect(page.getByText('How many documents are there?', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText('There is one.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /message/i })).toHaveCount(0);
});

test('the activity feed reads newest first and can be searched', async ({ page }) => {
  await openTab(page, 'activity');
  const search = page.getByPlaceholder('Search changes…');
  await expect(search).toBeVisible({ timeout: 20000 });

  const feedRows = () => page.locator('table').last().locator('tbody tr');
  // The search box draws before the feed's first page arrives, and a count does not wait.
  await expect
    .poll(() => feedRows().count(), { message: 'the dev database must have audit history' })
    .toBeGreaterThan(0);

  await search.fill('zzzznotathing');
  await expect(page.getByText(/No changes match/)).toBeVisible();

  await search.fill('');
  await expect(feedRows().first()).toBeVisible();
});

test('the log names the account behind each request, and this page itself stays out of it', async ({
  page,
}) => {
  // Two things that only show against a live server: the access line carries
  // the account (it carried nothing at all until the buffer was built), and
  // reading the log is not logged, so a screen left on Live cannot fill the
  // buffer with itself.
  await openTab(page, 'logs');
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 20000 });

  const requests = page.locator('table').last().locator('tbody tr');
  // The button's accessible name is the account it shows, and `exact` because
  // an email is a substring of plenty of other text on the page.
  const accounts = page.getByRole('button', { name: readToken().userId, exact: true });
  expect(
    await accounts.count(),
    'the requests this test just made should be attributed',
  ).toBeGreaterThan(0);

  const paths = await requests.locator('td:nth-child(4)').allTextContents();
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.some((p) => p.includes('/admin/logs'))).toBe(false);

  // Picking an account off a row narrows to it, and says so.
  await accounts.first().click();
  await expect(page.getByRole('button', { name: 'Clear account filter' })).toBeVisible();
});
