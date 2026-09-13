import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The assistant docked beside the entry list, on a vocabulary's Entries screen.
//
// No model and no service: an assistant is made to look online by answering the
// one discovery GET, the same trick as e2e/assistant-panel.spec.js. What is held
// still here is the part a turn does not touch:
//
//   - a vocabulary is its OWN resource with no project in scope, so the project
//     is resolved from the projects that link it. Exactly one, or no pane.
//   - the panel is STICKY on this screen, beside a left pane that already is,
//     rather than the viewport-bounded inner scroller a document gets. Its
//     composer has to stay on screen anyway.
//   - "Ask" names the entry with its homograph number, as find_entry takes it.
//
// This seeds its OWN vocabulary rather than using the fixture's. The point of
// the pane is that exactly one project links what you are looking at, and the
// fixture's lexicon is linked by whatever else has run against this dev core:
// the first version of this spec failed because an "E2E Probe" project from
// another session was still linked, which is the code being RIGHT.

const CORE = 'http://localhost:8085';

let projectId;
let vocabularyId;
const extraProjects = [];

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
  const vocab = await c.vocabLayers.create(`Panel lexicon ${Date.now()}`);
  vocabularyId = vocab.id;
  await c.projects.linkVocab(projectId, vocabularyId);
  // Two entries spelled alike, so one of them carries a homograph number and
  // the reference "Ask" writes has to include it.
  await c.vocabItems.create(vocabularyId, 'gam');
  await c.vocabItems.create(vocabularyId, 'gam');
  await c.vocabItems.create(vocabularyId, 'solo');
});

test.afterAll(async () => {
  // A seeded project that outlives its spec breaks other specs that take "the
  // first configured project", and a seeded vocabulary left linked breaks the
  // very rule this spec is about. Both go, whatever happened above.
  const c = client();
  for (const id of extraProjects) {
    await c.projects.delete(id).catch((e) => console.error('cleanup failed:', e.message));
  }
  if (vocabularyId) {
    await c.vocabLayers
      .delete(vocabularyId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const openEntries = async (page) => {
  await seedAuth(page);
  await page.goto(`/#/vocabularies/${vocabularyId}`);
  // "New" is a link, not a button: anything that navigates is a real anchor.
  await expect(page.getByRole('link', { name: 'New' })).toBeVisible({ timeout: 15000 });
};

test('no assistant online means no control on the Entries screen', async ({ page }) => {
  await withAssistant(page, []);
  await openEntries(page);
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
});

test('the panel docks beside the entry list and its composer is on screen', async ({ page }) => {
  await withAssistant(page);
  await openEntries(page);

  const open = page.getByRole('button', { name: 'Assistant', exact: true });
  await expect(open).toBeVisible({ timeout: 8000 });
  await open.click();

  // The panel names the vocabulary it is about.
  const panel = page.locator('aside').filter({ hasText: 'Panel lexicon' });
  await expect(panel).toBeVisible();

  // Sticky, not a viewport-filling inner scroller: at most as tall as the
  // viewport, with the composer inside it and on screen.
  const viewport = page.viewportSize();
  const box = await panel.boundingBox();
  expect(box.height).toBeLessThanOrEqual(viewport.height);
  const composer = panel.getByRole('textbox').first();
  await expect(composer).toBeVisible();
  const cbox = await composer.boundingBox();
  expect(cbox.y + cbox.height).toBeLessThanOrEqual(viewport.height + 1);
});

test('Ask names the open entry the way find_entry takes it', async ({ page }) => {
  await withAssistant(page);
  await openEntries(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();

  // Open the first of the two entries spelled "gam".
  await page.getByRole('link', { name: /^gam/ }).first().click();
  // Just "Ask", matching the per-sentence gesture in the interlinear editor and
  // in plaid-ud. The entry it is about is the heading right below it.
  const ask = page.getByRole('button', { name: 'Ask', exact: true });
  await expect(ask).toBeVisible({ timeout: 8000 });
  await ask.click();

  // The chip is the entry as the screen writes it out, number and all. It
  // clears on send, so it is asserted before anything is sent.
  await expect(page.locator('aside').getByText('gam 1', { exact: true })).toBeVisible();
});

test('Ask is not offered in a window with no room for the panel', async ({ page }) => {
  // Ask hands the shell a reference and the shell opens the panel on it, so
  // below the dock's width the button was present and pressing it did nothing.
  await withAssistant(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await openEntries(page);
  await page.getByRole('link', { name: /^gam/ }).first().click();
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
});

test('`@` offers the entries with the number that tells homographs apart', async ({ page }) => {
  // The case the gesture exists for. Two entries are spelled "gam" and only a
  // number separates them, which a reader has no way to know they need: the
  // list shows both, and what it writes is the reference find_entry takes.
  await withAssistant(page);
  await openEntries(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.locator('aside.border-l');
  await expect(panel).toBeVisible();

  const composer = panel.getByRole('textbox');
  await composer.fill('compare @gam');
  await expect(panel.getByText('Entries', { exact: true })).toBeVisible();
  await expect(panel.getByText('gam 1', { exact: true })).toBeVisible();
  await expect(panel.getByText('gam 2', { exact: true })).toBeVisible();

  await composer.press('Enter');
  // "#" and not a space: it is what the tool takes, and it is what this
  // screen's own Ask writes.
  await expect(composer).toHaveValue('compare gam#1 ');
});

test('a vocabulary two projects link is never filed under one of them', async ({ page }) => {
  // The ruling: a conversation belongs to one project, and filing it under one
  // the user did not choose puts it in an Assistant tab they were never on.
  //
  // What that looks like changed when the panel became app chrome. There is no
  // longer a per-screen control to withhold, and withholding the app's own
  // would be wrong: the panel may be holding a thread from somewhere else, and
  // it offers a project picker when it is not. So the rule is now about the
  // SUBJECT. This screen publishes none, so nothing here says the assistant is
  // about this vocabulary, and the reader chooses a project explicitly or not
  // at all.
  const c = client();
  const second = await c.projects.create(`Vocab assistant ${Date.now()}`);
  extraProjects.push(second.id);
  await c.projects.linkVocab(second.id, vocabularyId);

  await withAssistant(page);
  await openEntries(page);
  // The Ask gesture is what would attach an entry to a turn, and it needs the
  // resolved project, so it is not offered.
  await page.getByRole('link', { name: /^gam/ }).first().click();
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);

  // And the panel, opened here, is about a project the reader picks rather
  // than this vocabulary.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.locator('aside.border-l');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Choose a project')).toBeVisible();
});
