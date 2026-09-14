import { test, expect, seedAuth } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { assistantPanelHarness, assistantPanelTests } from '../../plaid-ui/e2e/assistantPanel.js';

// The assistant docked beside the interlinear grid, on the Analyze tab.
//
// No model, and no service: an assistant is made to look online by answering
// the one discovery GET. What is held still is what a turn does not touch.
//
// The dock is one component in plaid-ui, so every test about IT is there too
// (`assistantPanelTests`), driven with this app's screens. What stays here is
// the one thing that has no plaid-ud counterpart: this app's tab strip is
// sticky and plaid-ud's is not. The panel as APP chrome (it survives a
// navigation, it keeps one thread per project) is e2e/assistant-chrome.spec.js,
// and the tab itself (plans, Approve, Discard, Retry) is e2e/assistant.spec.js.

const DOCUMENT_NAME = 'Sample IGT Document';

let projectId;
let documentId;

test.beforeAll(async () => {
  ({ projectId, documentId } = await getFixture());
});

const panel = assistantPanelHarness({
  app: 'igt',
  expect,
  documentPath: () => `/#/projects/${projectId}/documents/${documentId}?tab=analyze`,
  contentSelector: '.igt-sentence',
});
const { withAssistant, panelOf, toggle, openDocument } = panel;

assistantPanelTests({
  test,
  expect,
  seedAuth,
  panel,
  documentName: DOCUMENT_NAME,
  ask: {
    // The island draws its own "Ask", so it has to be told about an absent
    // assistant too.
    absent: (page) => expect(page.locator('.igt-ask')).toHaveCount(0),
    // Hover-revealed, like Copy beside it. The grid is lit and the panel is
    // React, so the gesture goes over a window event, the same bridge the
    // auto-analyze opener uses.
    first: async (page) => {
      const sentence = page.locator('.igt-sentence').first();
      await sentence.hover();
      await sentence.locator('.igt-ask').click();
    },
    last: async (page) => {
      const sentence = page.locator('.igt-sentence').last();
      await sentence.scrollIntoViewIfNeeded();
      return {
        watch: sentence,
        click: async () => {
          await sentence.hover();
          await sentence.locator('.igt-ask').click();
        },
      };
    },
  },
  starterPrompt: 'Which words in this project are still unglossed?',
});

test('the tab strip stays pinned under the app header with the panel docked', async ({ page }) => {
  // A sticky offset is measured from the scrollport it sticks to, and the strip
  // once carried one meant for a different scrollport: it hung 57px down into
  // the grid, with rows scrolling through the gap above it. The dock is fixed,
  // so the PAGE is what scrolls whether it is open or not, and this is the case
  // that used to be wrong.
  const under = async () => {
    const header = await page.locator('header.sticky').boundingBox();
    const strip = await page.locator('div.sticky.z-30').first().boundingBox();
    return Math.round(strip.y - (header.y + header.height));
  };
  await seedAuth(page);
  await withAssistant(page);
  // Short, so the fixture's few sentences give the page something to scroll: a
  // document that fits leaves the strip in flow and never pins it.
  await page.setViewportSize({ width: 1280, height: 420 });
  await openDocument(page);
  await page.locator('.igt-island .igt-token-col').first().waitFor({ state: 'visible' });
  await toggle(page).click();
  await expect(panelOf(page)).toBeVisible();

  // Far enough that the strip is pinned rather than still in flow.
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect.poll(under).toBe(0);
});
