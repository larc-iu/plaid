import PlaidClient from '@larc-iu/plaid-client';
import { randomUUID } from 'node:crypto';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { assistantHarness } from '../../plaid-ui/e2e/assistantChrome.js';

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
// The stub service, the seeded conversations and the four locators are the
// shared harness in plaid-ui/e2e/assistantChrome.js, which plaid-igt's copy of
// this spec drives the same panel with. No model and no service: an assistant
// is made to look online by answering the one discovery GET.

const CORE = 'http://localhost:8085';
const SENTENCES = 'the dog runs. she sings.';
const WORDS = [
  [0, 3],
  [4, 7],
  [8, 12],
  [13, 16],
  [17, 22],
];
// Two sentences, so "which one" is a real question: the `@` test picks the
// second by what it SAYS and the reference it writes has to be s2.
const SENTENCE_SPANS = [
  [0, 13],
  [13, 24],
];
const SECOND_DOCUMENT = 'Chrome Spec Second Document';

let projectId;
let documentId;
let otherDocumentId;
let userId;
const seeded = []; // conversation ids to delete

const client = () => new PlaidClient(CORE, readToken().token);

const chrome = assistantHarness({
  app: 'ud',
  expect,
  client,
  userId: () => userId,
  projectId: () => projectId,
  documentPath: (id) => `/#/projects/${projectId}/documents/${id}/annotate`,
  contentSelector: '.sentence-grid',
});
const { withAssistant, panelOf, toggle, rail, openDock, gotoDocument, dropConversations } = chrome;

// Every seeded conversation is remembered so afterAll can take it away again.
const seedConversation = (title, text, updatedAt) => {
  const id = randomUUID();
  seeded.push(id);
  return chrome.seedConversation({ id, title, text, updatedAt });
};

const crumbs = (page) => page.getByRole('navigation', { name: 'Breadcrumb' });

// A project of its own, with ONE TOKENIZED DOCUMENT. Not the shared "E2E UD
// Fixture": its Doc 1 carries a text body and no tokens (fixtureProject.js
// never tokenizes it), so the annotation grid every test here waits for could
// never appear. The sibling spec seeds the same way for the same reason.
test.beforeAll(async () => {
  ({ userId } = readToken());
  ({ projectId, documentId } = await seedUdDoc(
    `Assistant chrome ${Date.now()}`,
    SENTENCES,
    WORDS,
    SENTENCE_SPANS,
  ));
  // A second document to walk to. It needs no annotation of its own: what the
  // tests read there is the breadcrumb and the panel beside it.
  otherDocumentId = (await client().documents.create(projectId, SECOND_DOCUMENT)).id;
});

// A seeded project left on the dev core is not inert: search.spec.js takes the
// first configured project that has tokens, so leftovers make it query a
// treebank with no dependency relations in it and fail.
test.afterAll(async () => {
  await dropConversations(seeded, [projectId]);
  if (projectId) {
    await client()
      .projects.delete(projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

test('the panel keeps its conversation across a navigation', async ({ page }) => {
  // The whole point. A half-typed message is the cheapest observable proof
  // that the panel was not torn down and rebuilt: its composer is component
  // state, so it cannot survive a remount. Nothing about the assistant is
  // stubbed beyond discovery, so this needs no service to answer.
  await seedAuth(page);
  await withAssistant(page);
  await gotoDocument(page, documentId);
  await openDock(page);

  const composer = panelOf(page).getByRole('textbox');
  await composer.fill('half a question about');

  // To another document in the same project.
  await page.goto(`/#/projects/${projectId}/documents/${otherDocumentId}/annotate`);
  await expect(crumbs(page)).toContainText(SECOND_DOCUMENT);
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
  await gotoDocument(page, documentId);
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
  await gotoDocument(page, documentId);
  await openDock(page);
  await panelOf(page).getByTitle('Hide the assistant').click();
  await expect(panelOf(page)).toHaveCount(0);

  await page.goto(`/#/projects/${projectId}/documents`);
  await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
  await expect(panelOf(page)).toHaveCount(0);
  await expect(toggle(page)).toBeVisible();

  // Reloading the app does not bring it back either.
  await gotoDocument(page, documentId);
  await expect(panelOf(page)).toHaveCount(0);
});

test('the handle waits at the edge, widens under the pointer, and does not open on hover', async ({
  page,
}) => {
  // The affordance the panel is reached by, and the reason it can start shut:
  // a sliver against the right edge that widens to show its mark. Hover must
  // NOT open the panel, or it would open itself every time the cursor drifted
  // out to a scrollbar.
  await seedAuth(page);
  await withAssistant(page);
  await gotoDocument(page, documentId);

  const handle = rail(page);
  await expect(handle).toBeVisible();
  const viewport = page.viewportSize();
  const idle = await handle.boundingBox();
  // Against the right edge, and vertically centred.
  expect(idle.x + idle.width).toBeGreaterThan(viewport.width - 2);
  expect(Math.abs(idle.y + idle.height / 2 - viewport.height / 2)).toBeLessThan(2);
  expect(idle.width).toBeLessThan(20);

  await handle.hover();
  await expect.poll(async () => (await handle.boundingBox()).width).toBeGreaterThan(idle.width * 2);
  // Widened, but the panel is still shut: hovering is not opening.
  await expect(panelOf(page)).toHaveCount(0);

  await handle.click();
  await expect(panelOf(page)).toBeVisible();
  // And both ways in step out of the way once the panel is open.
  await expect(handle).toHaveCount(0);
  await expect(toggle(page)).toHaveCount(0);
});

test('`@` offers the sentences of the open document, and Enter takes one', async ({ page }) => {
  // The reader's half of the reference vocabulary. Ask can only point at the
  // row you are looking at; `@` names a sentence you are not, and it matches on
  // what the sentence SAYS, because nobody knows they want s2.
  await seedAuth(page);
  await withAssistant(page);
  await gotoDocument(page, documentId);
  await openDock(page);

  const composer = panelOf(page).getByRole('textbox');
  await composer.fill('about @sings');
  const list = panelOf(page).getByText('Sentences', { exact: true });
  await expect(list).toBeVisible();
  await expect(panelOf(page).getByText('she sings')).toBeVisible();

  // Enter takes the highlighted row. It must NOT send: this composer sends on
  // Enter, and arbitrating that is the whole risk in the gesture.
  await composer.press('Enter');
  // The composer still HOLDING the text is the proof that nothing was sent:
  // send() clears it.
  await expect(composer).toHaveValue('about s2 ');
  await expect(panelOf(page).getByText('Sentences', { exact: true })).toHaveCount(0);

  // Escape closes the list and leaves what was typed alone.
  await composer.fill('about @s');
  await expect(panelOf(page).getByText('Sentences', { exact: true })).toBeVisible();
  await composer.press('Escape');
  await expect(panelOf(page).getByText('Sentences', { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue('about @s');
});

test('the panel comes back open if that is how it was left', async ({ page }) => {
  // Remembered per browser, and across a LOAD rather than only within the
  // session: a thread the reader was in the middle of is the likeliest reason
  // they came back to the app at all. A reader who has never opened it still
  // gets it shut, which is what the first assertion stands on.
  await seedAuth(page);
  await withAssistant(page);
  await gotoDocument(page, documentId);
  await expect(panelOf(page)).toHaveCount(0);

  await openDock(page);
  await page.reload();
  await expect(page.locator('.sentence-grid').first()).toBeVisible({ timeout: 15000 });
  await expect(panelOf(page)).toBeVisible();
  // Open, so neither way in is offered.
  await expect(toggle(page)).toHaveCount(0);
  await expect(rail(page)).toHaveCount(0);

  // And shut stays shut across one too.
  await panelOf(page).getByTitle('Hide the assistant').click();
  await expect(panelOf(page)).toHaveCount(0);
  await page.reload();
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

test('the panel is not offered on the Assistant tab, which is the same thread', async ({
  page,
}) => {
  // Both would draw the same live turn, each with its own step list, Stop
  // button and composer, and nothing would say which one was the live one.
  await seedAuth(page);
  await withAssistant(page);
  await gotoDocument(page, documentId);
  await openDock(page);

  await page.goto(`/#/projects/${projectId}/assistant`);
  await expect(page.getByRole('tab', { name: 'Assistant' })).toBeVisible();
  await expect(panelOf(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveCount(0);
  await expect(rail(page)).toHaveCount(0);

  // Off that tab and the panel is back, still open: the reader never shut it.
  await page.goto(`/#/projects/${projectId}/search`);
  await expect(page.getByRole('tab', { name: 'Search' })).toBeVisible();
  await expect(panelOf(page)).toBeVisible();
});

test('a window too narrow for a side panel is not offered one', async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page);
  await gotoDocument(page, documentId);
  await openDock(page);

  await page.setViewportSize({ width: 800, height: 800 });
  // Taking a third of 800px leaves neither the annotation nor the chat usable.
  await expect(panelOf(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveCount(0);
  // Including the grid's own "Ask": it hands the shell a reference and the
  // shell opens the panel on it, so here it would do nothing at all.
  await expect(page.getByRole('button', { name: 'Ask' })).toHaveCount(0);

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
  await gotoDocument(page, documentId);
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

  await gotoDocument(page, documentId);
  await openDock(page);

  // The newest, not a blank one: the panel comes back on every screen and on
  // every visit, so starting empty would mean going to find your own thread.
  const panel = panelOf(page);
  await expect(panel.getByText('the newer question')).toBeVisible();

  // To another document. The SAME thread, not one about the new document and
  // not a fresh one.
  await page.goto(`/#/projects/${projectId}/documents/${otherDocumentId}/annotate`);
  await expect(crumbs(page)).toContainText(SECOND_DOCUMENT);
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

  await gotoDocument(page, documentId);
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

  // And it can be shut from here, the way the chat can, before any project is
  // chosen. A panel with no way out is not "available", it is in the way.
  await panel.getByTitle('Hide the assistant').click();
  await expect(panel).toHaveCount(0);
  await toggle(page).click();
  await expect(panel.getByText('Choose a project')).toBeVisible();

  // Choosing one is what gives the panel something to be about, without
  // leaving the screen the reader is on.
  await panel.getByRole('button', { name: 'E2E UD Fixture' }).click();
  await expect(panel.getByText('Choose a project')).toHaveCount(0);
  await expect(panel.getByRole('textbox')).toBeVisible();
  await expect(page).toHaveURL(/#\/projects$/);
});
