import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// The assistant docked beside the interlinear grid, on the Analyze tab.
//
// No model, and no service: an assistant is made to look online by answering
// the one discovery GET. What is held still is what a turn does not touch, and
// all of it was built by hand against a browser:
//
//   - nothing is offered when no assistant is online, including the "Ask" the
//     lit island draws for itself
//   - the panel docks at exactly viewport height, composer reachable
//   - the island's "Ask" crosses to React and names the sentence
//
// The tab itself (plans, Approve, Discard, Retry) is e2e/assistant.spec.js,
// which seeds conversations into the record rather than stubbing anything.

const CORE = 'http://localhost:8085';

let projectId;
let documentId;

const ASSISTANT = [
  {
    serviceId: 'igt:assist:test',
    serviceName: 'IGT Assistant (test)',
    description: 'A stand-in for the specs.',
    extras: { model: 'test/model', tasks: ['assist'] },
    tasks: ['assist'],
    online: true,
  },
];

const withAssistant = (page, services = ASSISTANT) =>
  page.route('**/api/v1/projects/*/services', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(services) }),
  );

test.beforeAll(async () => {
  const client = new PlaidClient(CORE, readToken().token);
  const project = (await client.projects.list()).find((p) => p.name === 'E2E IGT Fixture');
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
  documentId = (await client.projects.listDocuments(projectId)).find(
    (d) => d.name === 'Sample IGT Document',
  ).id;
});

const analyze = (page) => page.goto(`/#/projects/${projectId}/documents/${documentId}?tab=analyze`);

test('nothing offers an assistant when none is online', async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page, []);
  await analyze(page);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();

  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
  // The island draws its own "Ask", so it has to be told too.
  await expect(page.locator('.igt-ask')).toHaveCount(0);
});

test('the panel docks at exactly viewport height', async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();

  const panel = page.locator('aside.border-l');
  await expect(panel).toBeVisible();
  await expect(panel.getByTitle('Sample IGT Document')).toBeVisible();

  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  // Guessing this in CSS put the composer off the bottom of the screen: the
  // app header, breadcrumbs, the tab strip, a run banner and the history
  // drawer all sit above it and not one is a fixed height.
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(box.y + box.height).toBeGreaterThan(viewport.height - 4);

  const composer = panel.getByRole('textbox');
  const cbox = await composer.boundingBox();
  expect(cbox.y + cbox.height).toBeLessThanOrEqual(viewport.height);
});

test("the island's Ask crosses to the panel and names the sentence", async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page);

  // Hover-revealed, like Copy beside it.
  const sentence = page.locator('.igt-sentence').first();
  await sentence.hover();
  await sentence.locator('.igt-ask').click();

  // The grid is lit and the panel is React: the gesture goes over a window
  // event, the same bridge the auto-analyze opener uses.
  const panel = page.locator('aside.border-l');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Sentence');
  await expect(panel).toContainText('s1');

  await panel.getByRole('button', { name: 'Remove' }).click();
  await expect(panel).not.toContainText('Sentence');
});
