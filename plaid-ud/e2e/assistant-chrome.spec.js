import PlaidClient from '@larc-iu/plaid-client';
import { randomUUID } from 'node:crypto';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The assistant panel as part of the app's chrome rather than one screen's.
//
// This is the property the whole arrangement exists for and the one the older
// panel could not have: the panel is mounted by the shell, so it survives a
// navigation and keeps the conversation the reader was having. Everything else
// here is a consequence of that being true.
//
// What a document screen owes the panel (its height, "Ask", the gutter it
// takes) is e2e/assistant-panel.spec.js.
//
// No model and no service: an assistant is made to look online by answering the
// one discovery GET, the same trick as e2e/assistant-panel.spec.js.

const CORE = 'http://localhost:8085';

let projectId;
let documentId;
let otherDocumentId;
let userId;
const seeded = []; // conversation ids to delete

const ASSISTANT = [
  {
    serviceId: 'ud:assist:test',
    serviceName: 'UD Assistant (test)',
    description: 'A stand-in for the specs.',
    extras: { model: 'test/model', app: 'ud', tasks: ['assist'] },
    tasks: ['assist'],
    online: true,
  },
];

const withAssistant = (page, services = ASSISTANT) =>
  page.route('**/api/v1/projects/*/services', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(services) }),
  );

const client = () => new PlaidClient(CORE, readToken().token);

const convKey = (kind, id) => `ud:assistant:${projectId}:${kind}:${id}`;

// A conversation is a record in the user's own key/value store that the service
// writes, so one can be seeded straight in and the panel driven from there. No
// model and no service needed.
const seedConversation = async (title, text, updatedAt) => {
  const id = randomUUID();
  seeded.push(id);
  const c = client();
  await c.userData.put(userId, convKey('conv', id), {
    messages: [
      { role: 'user', content: text },
      { role: 'assistant', content: 'Noted.' },
    ],
    display: [
      { kind: 'user', text },
      {
        kind: 'assistant',
        text: `Reply to ${title}`,
        plan: null,
        citations: [],
        status: null,
        model: 'e2e/model',
        steps: [],
        stepsSummary: '',
      },
    ],
  });
  await c.userData.put(userId, convKey('meta', id), {
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    serviceId: 'ud:assist:test',
    model: 'test/model',
    turns: 1,
    pending: null,
  });
  return id;
};

test.beforeAll(async () => {
  ({ userId } = readToken());
  const c = client();
  const project = (await c.projects.list()).find((p) => p.name === 'E2E UD Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const docs = await c.projects.listDocuments(projectId);
  documentId = docs.find((d) => d.name === 'Doc 1').id;
  // A second document to walk to. Reused by name across runs.
  const name = 'Chrome Spec Second Document';
  otherDocumentId = (
    docs.find((d) => d.name === name) || (await c.documents.create(projectId, name))
  ).id;
});

test.afterAll(async () => {
  const c = client();
  for (const id of seeded) {
    for (const kind of ['conv', 'meta']) {
      await c.userData.delete(userId, convKey(kind, id)).catch(() => {});
    }
  }
  if (otherDocumentId) {
    await c.documents
      .delete(otherDocumentId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const panelOf = (page) => page.locator('aside.border-l');
const toggle = (page) => page.getByRole('button', { name: 'Assistant', exact: true });
const annotate = (page, id) => page.goto(`/#/projects/${projectId}/documents/${id}/annotate`);
const crumbs = (page) => page.getByRole('navigation', { name: 'Breadcrumb' });

const openDock = async (page) => {
  await toggle(page).click();
  await expect(panelOf(page)).toBeVisible();
};

test('the panel keeps its conversation across a navigation', async ({ page }) => {
  // The whole point. A half-typed message is the cheapest observable proof
  // that the panel was not torn down and rebuilt: its composer is component
  // state, so it cannot survive a remount. Nothing about the assistant is
  // stubbed beyond discovery, so this needs no service to answer.
  await seedAuth(page);
  await withAssistant(page);
  await annotate(page, documentId);
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await openDock(page);

  const composer = panelOf(page).getByRole('textbox');
  await composer.fill('half a question about');

  // To another document in the same project.
  await annotate(page, otherDocumentId);
  await expect(crumbs(page)).toContainText('Chrome Spec Second Document');
  await expect(panelOf(page)).toBeVisible();
  await expect(panelOf(page).getByRole('textbox')).toHaveValue('half a question about');

  // And on to the project's own screens, which are not about a document at all.
  await page.goto(`/#/projects/${projectId}/documents`);
  await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
  await expect(panelOf(page)).toBeVisible();
  await expect(panelOf(page).getByRole('textbox')).toHaveValue('half a question about');
});

test('the panel holds its project on a screen that has none', async ({ page }) => {
  // /profile is about the person, not a project: none is in scope there at all.
  // The assistant is per project all the way down, so the panel keeps the one
  // it has rather than emptying itself or closing.
  await seedAuth(page);
  await withAssistant(page);
  await annotate(page, documentId);
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await openDock(page);
  await panelOf(page).getByRole('textbox').fill('still here');

  await page.goto('/#/profile');
  await expect(page.getByText('User Profile')).toBeVisible();
  await expect(panelOf(page)).toBeVisible();
  await expect(panelOf(page).getByRole('textbox')).toHaveValue('still here');
});

test('the panel stays shut across a navigation once it is shut', async ({ page }) => {
  // The flip side, and the reason the state is remembered per browser rather
  // than per screen: a reader who closed it does not want it back on the next
  // screen, or on the next visit.
  await seedAuth(page);
  await withAssistant(page);
  await annotate(page, documentId);
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await openDock(page);
  await panelOf(page).getByTitle('Hide the assistant').click();
  await expect(panelOf(page)).toHaveCount(0);

  await page.goto(`/#/projects/${projectId}/documents`);
  await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
  await expect(panelOf(page)).toHaveCount(0);
  await expect(toggle(page)).toBeVisible();

  // Reloading the app does not bring it back either.
  await annotate(page, documentId);
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await expect(panelOf(page)).toHaveCount(0);
});

test('the control is offered on every screen after signing in', async ({ page }) => {
  // "Always available" means the control does not come and go with the route.
  // On a screen with no project in scope it opens the picker instead of the
  // chat (see the last test in this file), which is why it is offered there
  // too rather than hidden.
  await seedAuth(page);
  await withAssistant(page);

  await page.goto('/#/projects');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(toggle(page)).toBeVisible();

  await page.goto(`/#/projects/${projectId}/documents`);
  await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
  await expect(toggle(page)).toBeVisible();

  await page.goto(`/#/projects/${projectId}/search`);
  await expect(page.getByRole('tab', { name: 'Search' })).toBeVisible();
  await expect(toggle(page)).toBeVisible();
});

test('a window too narrow for a side panel is not offered one', async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page);
  await annotate(page, documentId);
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await openDock(page);

  await page.setViewportSize({ width: 800, height: 800 });
  // Taking a third of 800px leaves neither the annotation nor the chat usable.
  await expect(panelOf(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveCount(0);

  // Widening gives it back, still open: the reader never closed it.
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(panelOf(page)).toBeVisible();
});

test('toasts do not land on top of the panel', async ({ page }) => {
  // Every toast in the app is bottom-right, which is exactly where the dock's
  // composer is. The shell publishes the dock's width and the toaster steps
  // left by it.
  await seedAuth(page);
  await withAssistant(page);
  await annotate(page, documentId);
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await openDock(page);

  const width = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--plaid-dock-width'),
  );
  expect(parseInt(width, 10)).toBeGreaterThan(0);

  // Sonner only paints its container once a toast is raised, so the rule is
  // checked against a stand-in carrying the attributes it sets.
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.setAttribute('data-sonner-toaster', '');
    el.setAttribute('data-x-position', 'right');
    el.style.position = 'fixed';
    el.style.bottom = '0';
    document.body.appendChild(el);
  });
  const right = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-sonner-toaster]')).right,
  );
  expect(parseInt(right, 10)).toBeGreaterThan(parseInt(width, 10));
});

test("the panel resumes the project's newest thread and holds it while the reader moves", async ({
  page,
}) => {
  // The decision this pins down: ONE thread per project, wherever you are in
  // it. Each subject used to remember its own, which is right for a panel that
  // belongs to one screen and wrong for one that does not: walking to the next
  // document swapped the conversation under the reader, so nothing spanning
  // two screens could be asked at all.
  await seedAuth(page);
  await withAssistant(page);
  const older = await seedConversation(
    'chrome older thread',
    'the older question',
    '2020-01-01T00:00:00.000Z',
  );
  const newer = await seedConversation(
    'chrome newer thread',
    'the newer question',
    '2030-01-01T00:00:00.000Z',
  );
  expect(older).not.toBe(newer);

  await annotate(page, documentId);
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await openDock(page);

  // The newest, not a blank one: the panel comes back on every screen and on
  // every visit, so starting empty would mean going to find your own thread.
  const panel = panelOf(page);
  await expect(panel.getByText('the newer question')).toBeVisible();

  // To another document. The SAME thread, not one about the new document and
  // not a fresh one.
  await annotate(page, otherDocumentId);
  await expect(crumbs(page)).toContainText('Chrome Spec Second Document');
  await expect(panel.getByText('the newer question')).toBeVisible();
  await expect(panel.getByText('the older question')).toHaveCount(0);

  // And on to a screen that is about the project at large.
  await page.goto(`/#/projects/${projectId}/search`);
  await expect(page.getByRole('tab', { name: 'Search' })).toBeVisible();
  await expect(panel.getByText('the newer question')).toBeVisible();
});

test('the panel opens a past conversation without leaving the screen', async ({ page }) => {
  // The panel is where the assistant lives now, so the list of past
  // conversations cannot live only in the tab: going there to find one means
  // leaving the annotation the question was about. It hangs off the panel's
  // own header instead, and picking a thread does not navigate.
  await seedAuth(page);
  await withAssistant(page);
  await seedConversation(
    'chrome archived thread',
    'the archived question',
    '2021-01-01T00:00:00.000Z',
  );

  await annotate(page, documentId);
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await openDock(page);
  const panel = panelOf(page);
  // From a blank conversation, so what the panel shows next can only have come
  // from the list.
  await panel.getByTitle('New conversation').click();
  await expect(panel.getByText('the archived question')).toHaveCount(0);

  const url = page.url();
  await panel.getByTitle('Past conversations').click();
  const history = page.getByRole('dialog');
  await history.getByText('chrome archived thread').click();
  await expect(panel.getByText('the archived question')).toBeVisible();
  // The popover closes on the way: it takes a third of the panel's height and
  // covers the thread it was asked to open.
  await expect(history).toHaveCount(0);
  // Still on the document. The conversation is not in this URL because the URL
  // belongs to the screen behind the panel.
  expect(page.url()).toBe(url);
});

test('the panel is reachable on the screen a reader lands on, and asks which project', async ({
  page,
}) => {
  // "Always available after login" has to include the FIRST screen. Nothing is
  // in scope there, and the assistant cannot work without a project, so the
  // panel asks for one rather than sitting empty or refusing to open.
  await seedAuth(page);
  await withAssistant(page);
  await page.goto('/#/projects');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  await toggle(page).click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Choose a project')).toBeVisible();

  // Choosing one is what gives the panel something to be about, without
  // leaving the screen the reader is on.
  await panel.getByRole('button', { name: 'E2E UD Fixture' }).click();
  await expect(panel.getByText('Choose a project')).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toBeVisible();
  await expect(page).toHaveURL(/#\/projects$/);
});
