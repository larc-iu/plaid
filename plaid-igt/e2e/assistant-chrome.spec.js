import PlaidClient from '@larc-iu/plaid-client';
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

test.beforeAll(async () => {
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
