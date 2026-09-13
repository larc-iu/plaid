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
// No model and no service: an assistant is made to look online by answering the
// one discovery GET, the same trick as e2e/assistant-panel.spec.js.

const CORE = 'http://localhost:8085';

let projectId;
let documentId;
let otherDocumentId;
let vocabularyId;
let userId;
let otherProjectId;
const seeded = []; // conversation ids to delete

const ASSISTANT = [
  {
    serviceId: 'igt:assist:test',
    serviceName: 'IGT Assistant (test)',
    description: 'A stand-in for the specs.',
    extras: { model: 'test/model', app: 'igt', tasks: ['assist'] },
    tasks: ['assist'],
    online: true,
  },
];

const withAssistant = (page, services = ASSISTANT) =>
  page.route('**/api/v1/projects/*/services', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(services) }),
  );

const client = () => new PlaidClient(CORE, readToken().token);

const convKey = (kind, id) => `igt:assistant:${projectId}:${kind}:${id}`;

// A conversation is a record in the user's own key/value store that the service
// writes, so one can be seeded straight in and the panel driven from there. No
// model and no service needed, the same as e2e/assistant.spec.js.
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
    serviceId: 'igt:assist:test',
    model: 'test/model',
    turns: 1,
    pending: null,
  });
  return id;
};

test.beforeAll(async () => {
  ({ userId } = readToken());
  const c = client();
  const project = (await c.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const docs = await c.projects.listDocuments(projectId);
  documentId = docs.find((d) => d.name === 'Sample IGT Document').id;
  // A second document to walk to. Reused by name across runs.
  const name = 'Chrome Spec Second Document';
  otherDocumentId = (
    docs.find((d) => d.name === name) || (await c.documents.create(projectId, name))
  ).id;
  const vocab = await c.vocabLayers.create(`Chrome lexicon ${Date.now()}`);
  vocabularyId = vocab.id;
  await c.projects.linkVocab(projectId, vocabularyId);
  await c.vocabItems.create(vocabularyId, 'solo');
});

test.afterAll(async () => {
  const c = client();
  for (const id of seeded) {
    for (const project of [projectId, otherProjectId].filter(Boolean)) {
      for (const kind of ['conv', 'meta']) {
        await c.userData.delete(userId, `igt:assistant:${project}:${kind}:${id}`).catch(() => {});
      }
    }
  }
  // A seeded project that outlives its spec breaks other specs that take "the
  // first configured project".
  if (otherProjectId) {
    await c.projects
      .delete(otherProjectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
  if (vocabularyId) {
    await c.vocabLayers
      .delete(vocabularyId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
  if (otherDocumentId) {
    await c.documents
      .delete(otherDocumentId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const panelOf = (page) => page.locator('aside.border-l');
const toggle = (page) => page.getByRole('button', { name: 'Assistant', exact: true });
const analyze = (page, id) => page.goto(`/#/projects/${projectId}/documents/${id}?tab=analyze`);

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
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
  await openDock(page);

  const composer = panelOf(page).getByRole('textbox');
  await composer.fill('half a question about');

  // To another document in the same project.
  await analyze(page, otherDocumentId);
  await expect(page.getByRole('heading', { name: 'Chrome Spec Second Document' })).toBeVisible();
  await expect(panelOf(page)).toBeVisible();
  await expect(panelOf(page).getByRole('textbox')).toHaveValue('half a question about');

  // And on to the project's own screens, which are not about a document at all.
  await page.goto(`/#/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'E2E IGT Fixture' })).toBeVisible();
  await expect(panelOf(page)).toBeVisible();
  await expect(panelOf(page).getByRole('textbox')).toHaveValue('half a question about');
});

test('the panel holds its project on a screen that has none', async ({ page }) => {
  // /vocabularies is a list of cross-project resources: no project is in scope
  // there at all. The assistant is per project all the way down, so the panel
  // keeps the one it has rather than emptying itself or closing.
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
  await openDock(page);
  const composer = panelOf(page).getByRole('textbox');
  await composer.fill('still here');

  await page.goto('/#/vocabularies');
  await expect(page.getByRole('heading', { name: 'Vocabularies' })).toBeVisible();
  await expect(panelOf(page)).toBeVisible();
  await expect(panelOf(page).getByRole('textbox')).toHaveValue('still here');
});

test('the panel stays shut across a navigation once it is shut', async ({ page }) => {
  // The flip side, and the reason the state is remembered per browser rather
  // than per screen: a reader who closed it does not want it back on the next
  // screen, or on the next visit.
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
  await openDock(page);
  await panelOf(page).getByTitle('Hide the assistant').click();
  await expect(panelOf(page)).toHaveCount(0);

  await page.goto(`/#/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'E2E IGT Fixture' })).toBeVisible();
  await expect(panelOf(page)).toHaveCount(0);
  await expect(toggle(page)).toBeVisible();

  // Reloading the app does not bring it back either.
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
  await expect(panelOf(page)).toHaveCount(0);
});

test('the handle waits at the edge, widens under the pointer, and does not open on hover', async ({
  page,
}) => {
  // The affordance the panel is reached by, and the reason it can start shut.
  // It mirrors the history rail on the LEFT edge of the document screen: a
  // sliver that widens to show its mark. Hover must NOT open the panel, or it
  // would open itself every time the cursor drifted out to a scrollbar.
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible({ timeout: 15000 });

  const rail = toggle(page);
  await expect(rail).toBeVisible();
  const viewport = page.viewportSize();
  const idle = await rail.boundingBox();
  // Against the right edge, and vertically centred.
  expect(idle.x + idle.width).toBeGreaterThan(viewport.width - 2);
  expect(Math.abs(idle.y + idle.height / 2 - viewport.height / 2)).toBeLessThan(2);
  expect(idle.width).toBeLessThan(20);

  await rail.hover();
  await expect.poll(async () => (await rail.boundingBox()).width).toBeGreaterThan(idle.width * 2);
  // Widened, but the panel is still shut: hovering is not opening.
  await expect(panelOf(page)).toHaveCount(0);

  await rail.click();
  await expect(panelOf(page)).toBeVisible();
  // And it steps out of the way once the panel it opens is open.
  await expect(rail).toHaveCount(0);
});

test('the panel is shut on every load, whatever the reader last did', async ({ page }) => {
  // It used to be remembered, so a reader who had opened it once met a third of
  // their window taken by a chat on every visit, before they had asked
  // anything. The handle at the right edge is how it opens now, and the
  // annotation is what a reader came for.
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible({ timeout: 15000 });
  await openDock(page);
  await panelOf(page).getByRole('textbox').fill('open when I left');

  await page.reload();
  await expect(toggle(page)).toBeVisible();
  await expect(panelOf(page)).toHaveCount(0);
  // And opening it again is one gesture, with the thread still there.
  await openDock(page);
  await expect(panelOf(page)).toBeVisible();
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

  await page.goto(`/#/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'E2E IGT Fixture' })).toBeVisible();
  await expect(toggle(page)).toBeVisible();

  await page.goto('/#/vocabularies');
  await expect(page.getByRole('heading', { name: 'Vocabularies' })).toBeVisible();
  await expect(toggle(page)).toBeVisible();
});

test('the picker is not offered where there is no annotation to ask about', async ({ page }) => {
  // The new-project wizard and the importers sit under /projects/ and have no
  // project, so nothing publishes a subject there. Offering to pick one would
  // put a chat about some other project beside a form for making a new one.
  await seedAuth(page);
  await withAssistant(page);
  await page.goto('/#/projects/new');
  await expect(page.getByRole('heading', { name: /New Project/i })).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
});

test('the page never scrolls sideways to make room for the panel', async ({ page }) => {
  // The dock is fixed and the shell pads by its width. Padding the wrong
  // element (or none) leaves the page as wide as it was and the panel sitting
  // on top of the annotation, which is the one thing it must never do.
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
  await openDock(page);

  const box = await panelOf(page).boundingBox();
  const overlap = await page.evaluate((panelLeft) => {
    const el = document.querySelector('.igt-sentence');
    return el.getBoundingClientRect().right - panelLeft;
  }, box.x);
  expect(overlap).toBeLessThanOrEqual(0);
  // And the app header stops short of it too, rather than running underneath.
  const header = await page.locator('header').first().boundingBox();
  expect(header.x + header.width).toBeLessThanOrEqual(box.x + 1);
});

test('a window too narrow for a side panel is not offered one', async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
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
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
  await openDock(page);

  const width = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--plaid-dock-width'),
  );
  expect(parseInt(width, 10)).toBeGreaterThan(0);

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

  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
  await openDock(page);

  // The newest, not a blank one: the panel comes back on every screen and on
  // every visit, so starting empty would mean going to find your own thread.
  const panel = panelOf(page);
  await expect(panel.getByText('the newer question')).toBeVisible();

  // To another document. The SAME thread, not one about the new document and
  // not a fresh one.
  await analyze(page, otherDocumentId);
  await expect(page.getByRole('heading', { name: 'Chrome Spec Second Document' })).toBeVisible();
  await expect(panel.getByText('the newer question')).toBeVisible();
  await expect(panel.getByText('the older question')).toHaveCount(0);

  // And on to the vocabulary, which is a different KIND of subject.
  await page.goto(`/#/vocabularies/${vocabularyId}`);
  await expect(page.getByRole('link', { name: 'New' })).toBeVisible({ timeout: 15000 });
  await expect(panel.getByText('the newer question')).toBeVisible();
});

test('the tab can list conversations from every project, and links them there', async ({
  page,
}) => {
  // A conversation belongs to the project it was started in: its record is
  // keyed by one, and only that project's assistant can answer it. So a reader
  // who remembers discussing something but not where needs to be able to see
  // across projects, and a row from elsewhere has to link THERE rather than
  // open here.
  await seedAuth(page);
  await withAssistant(page);
  const here = await seedConversation(
    'chrome thread here',
    'asked in this project',
    '2030-01-01T00:00:00.000Z',
  );
  const elsewhereId = randomUUID();
  seeded.push(elsewhereId);
  // `projects.create` answers with the id, not the whole project, so the name
  // this asserts on is the one it was given.
  const otherName = `Chrome Other Project ${Date.now()}`;
  const other = await client().projects.create(otherName);
  otherProjectId = other.id;
  const c = client();
  await c.userData.put(userId, `igt:assistant:${other.id}:conv:${elsewhereId}`, {
    messages: [],
    display: [{ kind: 'user', text: 'asked in the other project' }],
  });
  await c.userData.put(userId, `igt:assistant:${other.id}:meta:${elsewhereId}`, {
    id: elsewhereId,
    title: 'chrome thread elsewhere',
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
    serviceId: 'igt:assist:test',
    model: 'test/model',
    turns: 1,
    pending: null,
  });

  await page.goto(`/#/projects/${projectId}?tab=assistant`);
  const sidebar = page.getByRole('complementary').first();
  await expect(sidebar.getByRole('link', { name: /chrome thread here/ })).toBeVisible();
  // This project only, by default: nothing changes for a reader who never asks.
  await expect(sidebar.getByRole('link', { name: /chrome thread elsewhere/ })).toHaveCount(0);

  await sidebar.getByLabel('All projects').click();
  const foreign = sidebar.getByRole('link', { name: /chrome thread elsewhere/ });
  await expect(foreign).toBeVisible();
  // It names the project it is in, and links into THAT project's own tab.
  await expect(foreign).toContainText(otherName);
  await expect(foreign).toHaveAttribute(
    'href',
    new RegExp(`/projects/${other.id}\\?tab=assistant&conversation=${elsewhereId}$`),
  );
  // The one from here is still listed, and still links here.
  await expect(sidebar.getByRole('link', { name: /chrome thread here/ })).toHaveAttribute(
    'href',
    new RegExp(`/projects/${projectId}\\?tab=assistant&conversation=${here}$`),
  );
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

  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
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

test('a turn running in another project is not mistaken for one here', async ({ page }) => {
  // Navigating never stops a turn: the record gets the outcome either way. But
  // once the panel stopped being unmounted on a navigation, a job in another
  // project started arriving at the one on screen, whose list it does not
  // belong in. It is counted instead, with the way back to it.
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page, documentId);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();
  await openDock(page);
  const panel = panelOf(page);

  // A job for another project, put straight into the registry the way a real
  // one lives there. No service is needed: what is under test is which project
  // the panel attributes it to.
  const foreign = await page.evaluate(() => {
    const reg = globalThis.__plaidAssistantJobs;
    const id = 'e2e-foreign-conversation';
    reg.jobs.set(id, {
      id,
      projectId: 'e2e-foreign-project',
      kind: 'turn',
      conv: { id, messages: [], display: [] },
      progress: 'Thinking…',
      steps: [],
      done: false,
    });
    reg.jobListeners.forEach((fn) => fn(reg.jobs.get(id)));
    return id;
  });

  const back = panel.getByRole('link', { name: '1 running elsewhere' });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute(
    'href',
    new RegExp(`/projects/e2e-foreign-project\\?tab=assistant&conversation=${foreign}$`),
  );
  // And it is not reported as this conversation's own work: the composer is
  // still usable here.
  await expect(panel.getByRole('textbox')).toBeEnabled();

  // Gone once it finishes, without its row joining this project's list.
  await page.evaluate((id) => {
    const reg = globalThis.__plaidAssistantJobs;
    const j = reg.jobs.get(id);
    j.done = true;
    j.result = { conv: j.conv, meta: { id, title: 'foreign thread', updatedAt: '2030-01-01' } };
    reg.jobListeners.forEach((fn) => fn(j));
    reg.jobs.delete(id);
  }, foreign);
  await expect(back).toHaveCount(0);
  await expect(panel.getByText('foreign thread')).toHaveCount(0);
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
  await panel.getByRole('button', { name: 'E2E IGT Fixture' }).click();
  await expect(panel.getByText('Choose a project')).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toBeVisible();
  await expect(page).toHaveURL(/#\/projects$/);
});
