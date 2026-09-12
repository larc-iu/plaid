import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The assistant docked beside the entry list, on a vocabulary's Entries screen.
//
// No model and no service: an assistant is made to look online by answering the
// one discovery GET, the same trick as e2e/assistant-panel.spec.js. What is
// held still here is the part a turn does not touch:
//
//   - a vocabulary is its OWN resource with no project in scope, so the project
//     is resolved from the projects that link it. Exactly one, or no pane.
//   - the panel is STICKY on this screen, beside a left pane that already is,
//     rather than the viewport-bounded inner scroller a document gets. Its
//     composer has to stay on screen anyway.
//   - "Ask" names the entry with its homograph number, as find_entry takes it.

const CORE = 'http://localhost:8085';

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
  vocabularyId = (project.vocabs || []).find((v) => v.name === 'IGT Lexicon')?.id;
  if (!vocabularyId) throw new Error('the fixture project links no IGT Lexicon');
});

test.afterAll(async () => {
  // A seeded project that outlives its spec breaks other specs that take "the
  // first configured project". Deleted whatever happened above.
  const c = client();
  for (const id of extraProjects) {
    await c.projects.delete(id).catch((e) => console.error('cleanup failed:', e.message));
  }
});

const openEntries = async (page) => {
  await seedAuth(page);
  await page.goto(`/#/vocabularies/${vocabularyId}`);
  await expect(page.getByRole('button', { name: /New/ }).first()).toBeVisible({ timeout: 15000 });
};

test('no assistant online means no control on the Entries screen', async ({ page }) => {
  await withAssistant(page, []);
  await openEntries(page);
  await expect(page.getByRole('button', { name: 'Assistant' })).toHaveCount(0);
});

test('the panel docks beside the entry list and its composer is on screen', async ({ page }) => {
  await withAssistant(page);
  await openEntries(page);

  const open = page.getByRole('button', { name: 'Assistant' });
  await expect(open).toBeVisible({ timeout: 8000 });
  await open.click();

  // The panel names the vocabulary it is about.
  const panel = page.locator('aside').filter({ hasText: 'IGT Lexicon' });
  await expect(panel).toBeVisible();

  // Sticky, not a viewport-filling inner scroller: it sits inside the page's
  // own scrolling, at most as tall as the viewport, with the composer in it.
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box.height).toBeLessThanOrEqual(viewport.height);
  const composer = panel.getByRole('textbox');
  await expect(composer).toBeVisible();
  const cbox = await composer.boundingBox();
  expect(cbox.y + cbox.height).toBeLessThanOrEqual(viewport.height + 1);
});

test('Ask names the open entry the way find_entry takes it', async ({ page }) => {
  await withAssistant(page);
  await openEntries(page);
  await page.getByRole('button', { name: 'Assistant' }).click();

  // Open an entry, then ask about it.
  await page.getByRole('link', { name: /^all/ }).first().click();
  const ask = page.getByRole('button', { name: /^Ask about/ });
  await expect(ask).toBeVisible({ timeout: 8000 });
  await ask.click();

  // The chip carries the reference, which for an unnumbered entry is the bare
  // form. It clears on send, so it is asserted before sending anything.
  await expect(page.locator('aside').getByText('all', { exact: true }).first()).toBeVisible();
});

test('a vocabulary two projects link offers no pane at all', async ({ page }) => {
  // The ruling: a conversation belongs to one project, and filing it under one
  // the user did not choose puts it in an Assistant tab they were never on.
  const c = client();
  const second = await c.projects.create(`Vocab assistant ${Date.now()}`);
  extraProjects.push(second.id);
  await c.projects.linkVocab(second.id, vocabularyId);

  await withAssistant(page);
  await openEntries(page);
  await expect(page.getByRole('button', { name: 'Assistant' })).toHaveCount(0);
});
