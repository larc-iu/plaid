// The assistant panel while a document is open.
//
// The turn itself is not exercised here: that needs a model, and what can go
// wrong in the UI does not. What IS worth holding still is everything around
// it, because all of it was built by hand against a browser and none of it
// would survive a refactor otherwise:
//
//   - nothing is offered when no assistant is online
//   - the panel is exactly as tall as the screen, so its composer is reachable
//   - the editor goes on scrolling the page, open or shut
//   - a width survives a reload
//   - "Ask" on a sentence opens the panel with that sentence, and lets go
//
// The panel is APP CHROME, not this screen's: e2e/assistant-chrome.spec.js
// holds the properties that come from that (it survives a navigation, it keeps
// one thread per project, it is reachable everywhere).
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
    extras: { model: 'test/model', app: 'ud', tasks: ['assist'] },
    tasks: ['assist'],
    online: true,
  },
];

// The OTHER app's assistant, online on this very project: UD and IGT share
// projects, so this is the ordinary state of a shared one, not a contrivance.
const FOREIGN = [
  {
    serviceId: 'igt:assist:test',
    serviceName: 'Assistant from the other app',
    description: 'A stand-in for the specs.',
    extras: { model: 'test/model', app: 'igt', tasks: ['assist'] },
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

const panelOf = (page) => page.locator('aside.border-l');
const toggle = (page) => page.getByRole('button', { name: 'Assistant', exact: true });

test.describe('when no assistant is online', () => {
  test('nothing offers to open one', async ({ page }) => {
    await seedAuth(page);
    await withAssistant(page, []);
    await annotate(page);
    await expect(page.getByRole('button', { name: 'History' })).toBeVisible();

    // A control that opens an empty panel is worse than no control.
    await expect(toggle(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);

    // The project tab is not offered either, though its route still works.
    await page.goto(`/#/projects/${S.projectId}/documents`);
    await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Assistant' })).toHaveCount(0);
  });

  test("and the OTHER app's assistant does not count as one", async ({ page }) => {
    // It happened: the filter asked only whether a service does `assist`, so
    // IGT offered a `ud:assist:` service on a shared project. A conversation's
    // record is namespaced by the app it was started in, so every turn came
    // back "No such conversation" and the thread could never be answered.
    await seedAuth(page);
    await withAssistant(page, FOREIGN);
    await annotate(page);
    await expect(page.getByRole('button', { name: 'History' })).toBeVisible();
    await expect(toggle(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);

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

  test('the panel is exactly as tall as the screen, composer and all', async ({ page }) => {
    await annotate(page);
    await toggle(page).click();

    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    // ONE header bar. The panel used to carry a second one above the
    // assistant's own row, naming the document, which the page's heading says
    // a few pixels to the left. The hide button lives in the remaining row.
    await expect(panel.locator('header')).toHaveCount(1);
    await expect(panel.locator('header')).not.toContainText('Doc');
    await expect(panel.getByTitle('Hide the assistant')).toBeVisible();

    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    // It is fixed to the viewport, so this holds by construction rather than by
    // measurement. It did not always: guessing a height in CSS put the composer
    // off the bottom, because an app header, breadcrumbs, a tab strip and a run
    // banner all sit above where the panel used to start.
    expect(box.y).toBe(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 4);

    const composer = panel.getByRole('textbox');
    const cbox = await composer.boundingBox();
    expect(cbox.y + cbox.height).toBeLessThanOrEqual(viewport.height);
  });

  test('the PAGE scrolls, open or shut', async ({ page }) => {
    // The panel is fixed and the shell pads a gutter for it, so opening it does
    // not change what scrolls. It used to: the editor row was bounded to the
    // viewport and became its own scrollport, which is what every sticky offset
    // and every measured height in the app then had to agree with.
    await annotate(page);
    const scrolls = () =>
      page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1);
    await page.setViewportSize({ width: 1400, height: 420 });
    await expect.poll(scrolls).toBe(true);

    await toggle(page).click();
    await expect(panelOf(page)).toBeVisible();
    expect(await scrolls()).toBe(true);

    await page.getByRole('button', { name: 'Hide the assistant' }).click();
    await expect(panelOf(page)).toHaveCount(0);
    await expect.poll(scrolls).toBe(true);
  });

  test('the panel never covers the annotation', async ({ page }) => {
    // The shell pads by the dock's width. Padding the wrong element (or none)
    // leaves the page as wide as it was and the panel sitting on top of the
    // grid, which is the one thing it must never do.
    await annotate(page);
    await expect(page.locator('.sentence-grid').first()).toBeVisible();
    await toggle(page).click();
    const box = await panelOf(page).boundingBox();

    const overlap = await page.evaluate((panelLeft) => {
      const el = document.querySelector('.sentence-grid');
      return el.getBoundingClientRect().right - panelLeft;
    }, box.x);
    expect(overlap).toBeLessThanOrEqual(0);
    // And the app header stops short of it too, rather than running underneath.
    const header = await page.locator('header').first().boundingBox();
    expect(header.x + header.width).toBeLessThanOrEqual(box.x + 1);
  });

  test('a width survives a reload', async ({ page }) => {
    await annotate(page);
    await toggle(page).click();
    const panel = panelOf(page);
    const before = (await panel.boundingBox()).width;

    const grip = page.getByRole('separator', { name: 'Resize the assistant' });
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x - 90, g.y + g.height / 2, { steps: 8 });
    await page.mouse.up();

    const widened = (await panel.boundingBox()).width;
    expect(widened).toBeGreaterThan(before + 40);

    // The WIDTH is remembered; whether it was open is not, so this opens it
    // again from the handle and reads the width it comes back at.
    await page.reload();
    await expect(panelOf(page)).toHaveCount(0);
    await toggle(page).click();
    const after = (await panelOf(page).boundingBox()).width;
    expect(Math.abs(after - widened)).toBeLessThan(3);
  });

  test('"Ask" puts the sentence in the composer and then lets go of it', async ({ page }) => {
    await annotate(page);
    // The gesture opens the panel by itself: it is how you start asking.
    await page.getByRole('button', { name: 'Ask', exact: true }).first().click();

    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Sentence');
    await expect(panel).toContainText('s1');

    // Removing the chip leaves the conversation alone.
    await panel.getByRole('button', { name: 'Remove' }).click();
    await expect(panel).not.toContainText('Sentence');
  });

  test('Ask keeps the reader where they were', async ({ page }) => {
    // Opening the panel used to dump the reader at the top of the document:
    // measuring the docked height puts the page at the top to do it, and the
    // discarded offset was the reader's place. Worst on "Ask", whose whole
    // point is the sentence in front of you. Fixed in the shell, nothing
    // measures anything and the page is never touched, so the assertion is
    // that the scroll position is UNCHANGED rather than restored.
    await annotate(page);
    await page.setViewportSize({ width: 1400, height: 400 });
    const ask = page.getByRole('button', { name: 'Ask', exact: true }).last();
    await ask.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const scrolledTo = await page.evaluate(() => window.scrollY);

    await ask.click();
    await expect(panelOf(page)).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolledTo);
  });

  test("the panel does not build the tab's chrome", async ({ page }) => {
    await annotate(page);
    await toggle(page).click();
    const panel = panelOf(page);
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
