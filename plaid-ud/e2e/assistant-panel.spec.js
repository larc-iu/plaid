import { test, expect, seedAuth } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { assistantPanelHarness, assistantPanelTests } from '../../plaid-ui/e2e/assistantPanel.js';

// The assistant panel while a document is open.
//
// The turn itself is not exercised here: that needs a model, and what can go
// wrong in the UI does not. An assistant is made to look online by answering
// the discovery call, which is one GET. Registering a real service would mean
// implementing the request protocol in a test, and would test the server rather
// than this.
//
// The dock is one component in plaid-ui, so the six tests that are about IT are
// there too (`assistantPanelTests`), driven with this app's screens. What stays
// here is what this app's editor makes different. The panel as APP chrome (it
// survives a navigation, it keeps one thread per project, it is reachable
// everywhere) is e2e/assistant-chrome.spec.js.

const S = {};

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

const panel = assistantPanelHarness({
  app: 'ud',
  expect,
  documentPath: () => `/#/projects/${S.projectId}/documents/${S.documentId}/annotate`,
  contentSelector: '.sentence-grid',
});
const { withAssistant, panelOf, toggle, openDocument } = panel;

const askButton = (page) => page.getByRole('button', { name: 'Ask', exact: true });

assistantPanelTests({
  test,
  expect,
  seedAuth,
  panel,
  documentName: 'Doc',
  ask: {
    absent: (page) => expect(askButton(page)).toHaveCount(0),
    first: (page) => askButton(page).first().click(),
    last: async (page) => {
      const button = askButton(page).last();
      await button.scrollIntoViewIfNeeded();
      return { watch: button, click: () => button.click() };
    },
  },
  // The project tab goes with the panel, though its route still works.
  alsoHidden: async (page) => {
    await page.goto(`/#/projects/${S.projectId}/documents`);
    await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Assistant' })).toHaveCount(0);
  },
});

test.describe('with an assistant online', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await withAssistant(page);
  });

  test('the PAGE scrolls, open or shut', async ({ page }) => {
    // The panel is fixed and the shell pads a gutter for it, so opening it does
    // not change what scrolls. It used to: the editor row was bounded to the
    // viewport and became its own scrollport, which is what every sticky offset
    // and every measured height in the app then had to agree with.
    await openDocument(page);
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

  test('a width survives a reload', async ({ page }) => {
    await openDocument(page);
    await toggle(page).click();
    const before = (await panelOf(page).boundingBox()).width;

    const grip = page.getByRole('separator', { name: 'Resize the assistant' });
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x - 90, g.y + g.height / 2, { steps: 8 });
    await page.mouse.up();

    const widened = (await panelOf(page).boundingBox()).width;
    expect(widened).toBeGreaterThan(before + 40);

    // Both the width and the open state are remembered, so it comes back open
    // at the width it was dragged to.
    await page.reload();
    await expect(panelOf(page)).toBeVisible();
    const after = (await panelOf(page).boundingBox()).width;
    expect(Math.abs(after - widened)).toBeLessThan(3);
  });

  test("the panel does not build the tab's chrome", async ({ page }) => {
    await openDocument(page);
    await toggle(page).click();
    const dock = panelOf(page);
    await expect(dock).toBeVisible();

    // These were once hidden with CSS, which still built every conversation row
    // and every starter prompt inside a 400px panel. They are not rendered at
    // all now, so the assertion is on the DOM and not on what is visible:
    // `toContainText` reads hidden text too, which is how it was missed by
    // hand.
    await expect(dock.locator('text=Conversations are private')).toHaveCount(0);
    await expect(dock.getByText('Summarize the parts of speech')).toHaveCount(0);

    // What it does carry: the conversation, and a way to the full tab.
    await expect(dock.getByRole('textbox')).toBeVisible();
    await expect(dock.getByRole('button', { name: 'New conversation' })).toBeVisible();
  });
});
