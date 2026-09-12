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
    for (const kind of ['conv', 'meta']) {
      await c.userData.delete(userId, convKey(kind, id)).catch(() => {});
    }
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

test('the control is offered on a project screen and not off one', async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page);
  await page.goto('/#/projects');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  // No project is in scope and none has been seen, so there is nothing for an
  // assistant to be about.
  await expect(toggle(page)).toHaveCount(0);

  await page.goto(`/#/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'E2E IGT Fixture' })).toBeVisible();
  await expect(toggle(page)).toBeVisible();
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
