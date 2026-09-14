import PlaidClient from '@larc-iu/plaid-client';
import { randomUUID } from 'node:crypto';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { assistantHarness, assistantChromeTests } from '../../plaid-ui/e2e/assistantChrome.js';

// The assistant panel as part of the app's chrome rather than one screen's.
//
// This is the property the whole arrangement exists for and the one the older
// panel could not have: the panel is mounted by the shell, so it survives a
// navigation and keeps the conversation the reader was having.
//
// The chrome is one component in plaid-ui, so the thirteen tests that are about
// IT are there too (`assistantChromeTests`), driven with this app's screens.
// What stays here is what this app's routes, subjects and island make
// different. No model and no service: an assistant is made to look online by
// answering the one discovery GET.

const CORE = 'http://localhost:8085';
const FIXTURE = 'E2E IGT Fixture';
const SECOND_DOCUMENT = 'Chrome Spec Second Document';

let projectId;
let documentId;
let otherDocumentId;
let vocabularyId;
let userId;
let otherProjectId;
const seeded = []; // conversation ids to delete

const client = () => new PlaidClient(CORE, readToken().token);

const chrome = assistantHarness({
  app: 'igt',
  expect,
  client,
  userId: () => userId,
  projectId: () => projectId,
  documentPath: (id) => `/#/projects/${projectId}/documents/${id}?tab=analyze`,
  contentSelector: '.igt-sentence',
});
const { withAssistant, panelOf, toggle, openDock, gotoDocument, dropConversations } = chrome;

// Every seeded conversation is remembered so afterAll can take it away again.
const seedConversation = (title, text, updatedAt, inProject) => {
  const id = randomUUID();
  seeded.push(id);
  return chrome.seedConversation({ id, title, text, updatedAt, inProject });
};

const seeContent = async (page) =>
  expect(page.locator('.igt-sentence').first()).toBeVisible({ timeout: 15000 });

test.beforeAll(async () => {
  ({ userId } = readToken());
  const c = client();
  const project = (await c.projects.list()).find((p) => p.name === FIXTURE);
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  const docs = await c.projects.listDocuments(projectId);
  documentId = docs.find((d) => d.name === 'Sample IGT Document').id;
  // A second document to walk to. Reused by name across runs.
  otherDocumentId = (
    docs.find((d) => d.name === SECOND_DOCUMENT) ||
    (await c.documents.create(projectId, SECOND_DOCUMENT))
  ).id;
  const vocab = await c.vocabLayers.create(`Chrome lexicon ${Date.now()}`);
  vocabularyId = vocab.id;
  await c.projects.linkVocab(projectId, vocabularyId);
  await c.vocabItems.create(vocabularyId, 'solo');
});

test.afterAll(async () => {
  const c = client();
  await dropConversations(seeded, [projectId, otherProjectId]);
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

const projectScreen = {
  path: () => `/#/projects/${projectId}`,
  seen: (page) => expect(page.getByRole('heading', { name: FIXTURE })).toBeVisible(),
};

// A list of cross-project resources: no project is in scope there at all.
const vocabularies = {
  path: () => '/#/vocabularies',
  seen: (page) => expect(page.getByRole('heading', { name: 'Vocabularies' })).toBeVisible(),
};

assistantChromeTests({
  test,
  expect,
  seedAuth,
  chrome,
  documentId: () => documentId,
  secondDocument: {
    path: () => `/#/projects/${projectId}/documents/${otherDocumentId}?tab=analyze`,
    // It has no sentences of its own, so what says it has arrived is its
    // heading.
    seen: (page) => expect(page.getByRole('heading', { name: SECOND_DOCUMENT })).toBeVisible(),
  },
  projectScreen,
  // A different KIND of subject, which the thread still has to survive.
  elsewhere: {
    path: () => `/#/vocabularies/${vocabularyId}`,
    seen: (page) => expect(page.getByRole('link', { name: 'New' })).toBeVisible({ timeout: 15000 }),
  },
  projectlessScreen: vocabularies,
  assistantTab: {
    path: () => `/#/projects/${projectId}?tab=assistant`,
    seen: (page) => expect(page.getByRole('complementary').first()).toBeVisible(),
  },
  screensWithControl: [projectScreen, vocabularies],
  mention: {
    typed: 'about @humanos',
    shows: /Todos los seres humanos/,
    inserts: 'about s1 ',
  },
  projectName: () => FIXTURE,
  ask: {
    // Reloaded, because the island draws its rows from its own state and does
    // not repaint on a resize.
    hide: async (page) => {
      await page.reload();
      await seeContent(page);
      await expect(page.locator('button.igt-ask')).toHaveCount(0);
    },
    show: async (page) => {
      await page.reload();
      await seeContent(page);
      await expect(page.locator('button.igt-ask').first()).toBeVisible();
    },
  },
  seedConversation,
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
  // `projects.create` answers with the id, not the whole project, so the name
  // this asserts on is the one it was given.
  const otherName = `Chrome Other Project ${Date.now()}`;
  const other = await client().projects.create(otherName);
  otherProjectId = other.id;
  const elsewhereId = await seedConversation(
    'chrome thread elsewhere',
    'asked in the other project',
    '2029-01-01T00:00:00.000Z',
    other.id,
  );

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

test('a turn running in another project is not mistaken for one here', async ({ page }) => {
  // Navigating never stops a turn: the record gets the outcome either way. But
  // once the panel stopped being unmounted on a navigation, a job in another
  // project started arriving at the one on screen, whose list it does not
  // belong in. It is counted instead, with the way back to it.
  await seedAuth(page);
  await withAssistant(page);
  await gotoDocument(page, documentId);
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
