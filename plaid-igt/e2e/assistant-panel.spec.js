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
    extras: { model: 'test/model', app: 'igt', tasks: ['assist'] },
    tasks: ['assist'],
    online: true,
  },
];

// The OTHER app's assistant, online on this very project. UD and IGT share
// projects, so that is the ordinary state of a shared one, not a contrivance.
const FOREIGN = [
  {
    serviceId: 'ud:assist:test',
    serviceName: 'Assistant from the other app',
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

test("the OTHER app's assistant does not count as one", async ({ page }) => {
  // It happened, and this is the project it happened on: UD and IGT share
  // projects, the filter asked only whether a service does `assist`, so this
  // app offered a `ud:assist:` service. A conversation's record is namespaced
  // by the app it was started in, so every turn came back "No such
  // conversation" and the thread could never be answered.
  await seedAuth(page);
  await withAssistant(page, FOREIGN);
  await analyze(page);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();

  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
  await expect(page.locator('.igt-ask')).toHaveCount(0);
});

test('the panel docks at exactly viewport height', async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();

  const panel = page.locator('aside.border-l');
  await expect(panel).toBeVisible();
  // ONE header bar. The panel used to carry a second one above the assistant's
  // own row, repeating the document's name, which the page's heading says a few
  // pixels to the left. The hide button lives in the remaining row.
  await expect(panel.locator('header')).toHaveCount(1);
  // The HEADER does not repeat it. The empty-state line below still names what
  // the panel is about, which is a sentence rather than a second title bar.
  await expect(panel.locator('header')).not.toContainText('Sample IGT Document');
  await expect(panel.getByTitle('Hide the assistant')).toBeVisible();

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

test('the panel picks which assistant answers, while the thread is new', async ({ page }) => {
  const TWO = [
    ASSISTANT[0],
    {
      serviceId: 'igt:assist:other',
      serviceName: 'IGT Assistant (other)',
      description: 'A second stand-in.',
      extras: { model: 'other/model', app: 'igt', tasks: ['assist'] },
      tasks: ['assist'],
      online: true,
    },
  ];
  await seedAuth(page);
  await withAssistant(page, TWO);
  await analyze(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.locator('aside.border-l');
  await expect(panel).toBeVisible();

  // The model's name IS the picker while the conversation is new.
  const picker = panel.getByRole('combobox', { name: 'Assistant' });
  await expect(picker).toHaveText('test/model');
  await picker.click();
  await page.getByRole('option', { name: 'other/model' }).click();
  await expect(picker).toHaveText('other/model');
});

test('the panel names the one assistant rather than offering a choice of one', async ({ page }) => {
  await seedAuth(page);
  await withAssistant(page);
  await analyze(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.locator('aside.border-l');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('test/model')).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Assistant' })).toHaveCount(0);
});

test('the tab strip stays pinned under the app header, docked or not', async ({ page }) => {
  // A sticky offset is measured from the scrollport it sticks to, and which
  // one that IS changes here: normally the page scrolls, but with the panel
  // docked the content scrolls inside itself, below the app header already.
  // The strip kept the page's offset and so hung 57px down into the grid,
  // with rows scrolling through the gap above it.
  const under = async () => {
    const header = await page.locator('header.sticky').boundingBox();
    const strip = await page.locator('div.sticky.z-30').first().boundingBox();
    return Math.round(strip.y - (header.y + header.height));
  };
  await seedAuth(page);
  await withAssistant(page);
  // Short, so the fixture's few sentences give the PAGE something to scroll:
  // undocked, a document that fits leaves the strip in flow and never pins it.
  await page.setViewportSize({ width: 1280, height: 420 });
  await analyze(page);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });

  // Far enough that the strip is pinned rather than still in flow, whichever
  // of the two is the thing that scrolls.
  const scrollDown = async () => {
    await page.evaluate(() => {
      const inner = [...document.querySelectorAll('*')].find((el) => {
        const cs = getComputedStyle(el);
        return (
          (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight
        );
      });
      if (inner) inner.scrollTop = 1500;
      window.scrollTo(0, 1500);
    });
    await page.waitForTimeout(400);
  };
  await scrollDown();
  expect(await under(), 'pinned with the page scrolling').toBe(0);

  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.locator('aside.border-l')).toBeVisible();
  await scrollDown();
  expect(await under(), 'pinned with the content scrolling inside itself').toBe(0);
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

test('docking keeps the reader where they were, and Ask keeps its sentence', async ({ page }) => {
  // Measuring the docked height has to put the page at the top, and that used
  // to throw the reader's place away: opening the panel from anywhere but the
  // first line dumped them back at the top of the document. Worst on "Ask",
  // whose whole point is the sentence in front of you.
  await seedAuth(page);
  await withAssistant(page);
  // Short enough that this document really scrolls.
  await page.setViewportSize({ width: 1280, height: 400 });
  await analyze(page);
  await expect(page.locator('.igt-sentence').first()).toBeVisible();

  const last = page.locator('.igt-sentence').last();
  await last.scrollIntoViewIfNeeded();
  await expect.poll(async () => await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const before = await last.boundingBox();

  await last.hover();
  await last.locator('.igt-ask').click();

  const panel = page.locator('aside.border-l');
  await expect(panel).toBeVisible();
  // The page itself is at the top now, by design: the row scrolls instead.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // The sentence asked about is still on screen, within a line of where it was.
  const after = await last.boundingBox();
  expect(after).not.toBeNull();
  expect(after.y).toBeGreaterThan(0);
  expect(after.y).toBeLessThan(400);
  expect(Math.abs(after.y - before.y)).toBeLessThan(80);
});
