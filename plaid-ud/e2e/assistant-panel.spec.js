// The assistant docked beside a document.
//
// The turn itself is not exercised here: that needs a model, and what can go
// wrong in the UI does not. What IS worth holding still is everything around
// it, because all of it was built by hand against a browser and none of it
// would survive a refactor otherwise:
//
//   - nothing is offered when no assistant is online
//   - the panel docks at exactly viewport height, so its composer is reachable
//   - the editor keeps its own scrolling when the panel is closed
//   - a width survives a reload
//   - "Ask" on a sentence puts that sentence in the composer, and lets go
//
// An assistant is made to look online by answering the discovery call, which
// is one GET. Registering a real service would mean implementing the request
// protocol in a test, and would test the server rather than this.
import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';

const S = {};

const ASSISTANT = [
  {
    serviceId: 'ud:assist:test',
    serviceName: 'UD Assistant (test)',
    description: 'A stand-in for the specs.',
    extras: { model: 'test/model', tasks: ['assist'] },
    tasks: ['assist'],
    online: true,
  },
];

// The one call that decides whether an assistant exists. `online: false`
// (or an empty list) is how "none running" looks to the app.
const withAssistant = (page, services = ASSISTANT) =>
  page.route('**/api/v1/projects/*/services', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(services) }),
  );

test.beforeAll(async () => {
  Object.assign(
    S,
    await seedUdDoc(`Assistant panel ${Date.now()}`, 'the dog runs. she sings.', [
      [0, 3],
      [4, 7],
      [8, 12],
      [13, 16],
      [17, 22],
    ]),
  );
});

// Every seeded project stays on the dev core otherwise, and other specs pick
// a project by scanning: search.spec.js takes the first configured one that
// has tokens, so eight leftover "Assistant panel" projects (which have words
// and no dependency relations) made it query an empty treebank and fail.
test.afterAll(async () => {
  if (S.client && S.projectId) {
    await S.client.projects
      .delete(S.projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const annotate = (page) =>
  page.goto(`/#/projects/${S.projectId}/documents/${S.documentId}/annotate`);

test.describe('when no assistant is online', () => {
  test('nothing offers to open one', async ({ page }) => {
    await seedAuth(page);
    await withAssistant(page, []);
    await annotate(page);
    await expect(page.getByRole('button', { name: 'History' })).toBeVisible();

    // A control that opens an empty panel is worse than no control.
    await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);

    // The project tab is not offered either, though its route still works.
    await page.goto(`/#/projects/${S.projectId}/documents`);
    await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Assistant' })).toHaveCount(0);
  });
});

test.describe('when one is online', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await withAssistant(page);
  });

  test('the panel docks at exactly viewport height, composer and all', async ({ page }) => {
    await annotate(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();

    const panel = page.locator('aside.border-l');
    await expect(panel).toBeVisible();
    // It names the document it is about (seedUdDoc calls it "Doc").
    await expect(panel.getByTitle('Doc')).toBeVisible();

    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    // The bottom edge lands on the bottom of the screen, not past it: guessing
    // this in CSS put the composer off the bottom, because an app header,
    // breadcrumbs, a tab strip and a run banner all sit above it.
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 4);

    const composer = panel.getByRole('textbox');
    const cbox = await composer.boundingBox();
    expect(cbox.y + cbox.height).toBeLessThanOrEqual(viewport.height);
  });

  test('the page scrolls again once the panel is closed', async ({ page }) => {
    await annotate(page);
    const scrolls = () =>
      page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1);

    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(page.locator('aside.border-l')).toBeVisible();
    expect(await scrolls()).toBe(false); // the editor scrolls inside itself now

    await page.getByRole('button', { name: 'Hide the assistant' }).click();
    await expect(page.locator('aside.border-l')).toHaveCount(0);
    // And the document is back to scrolling the page, as it always did. The
    // old assertion here read `documentElement.style.height || 'auto'` and
    // checked it was not '0px'; nothing ever sets that property, so it was
    // 'auto' on every page and the close half of this test verified nothing.
    await expect.poll(scrolls).toBe(true);
  });

  test('a width survives a reload', async ({ page }) => {
    await annotate(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const panel = page.locator('aside.border-l');
    const before = (await panel.boundingBox()).width;

    const grip = page.getByRole('separator', { name: 'Resize the assistant' });
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x - 90, g.y + g.height / 2, { steps: 8 });
    await page.mouse.up();

    const widened = (await panel.boundingBox()).width;
    expect(widened).toBeGreaterThan(before + 40);

    await page.reload();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const after = (await page.locator('aside.border-l').boundingBox()).width;
    expect(Math.abs(after - widened)).toBeLessThan(3);
  });

  test('"Ask" puts the sentence in the composer and then lets go of it', async ({ page }) => {
    await annotate(page);
    // The gesture opens the panel by itself: it is how you start asking.
    await page.getByRole('button', { name: 'Ask', exact: true }).first().click();

    const panel = page.locator('aside.border-l');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Sentence');
    await expect(panel).toContainText('s1');

    // Removing the chip leaves the conversation alone.
    await panel.getByRole('button', { name: 'Remove' }).click();
    await expect(panel).not.toContainText('Sentence');
  });

  test("the panel does not build the tab's chrome", async ({ page }) => {
    await annotate(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const panel = page.locator('aside.border-l');
    await expect(panel).toBeVisible();

    // These were once hidden with CSS, which still built every conversation
    // row and every starter prompt inside a 400px panel. They are not
    // rendered at all now, so the assertion is on the DOM and not on what is
    // visible: `toContainText` reads hidden text too, which is how it was
    // missed by hand.
    expect(await panel.locator('text=Conversations are private').count()).toBe(0);
    expect(await panel.getByText('Summarize the parts of speech').count()).toBe(0);

    // What it does carry: the conversation, and a way to the full tab.
    await expect(panel.getByRole('textbox')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'New conversation' })).toBeVisible();
  });
});
