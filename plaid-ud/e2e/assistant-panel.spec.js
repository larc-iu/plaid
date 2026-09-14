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
// The dock is one component in plaid-ui, so every test about IT is there too
// (`assistantPanelTests`), driven with this app's screens. What stays here is
// the seeding: a project with one tokenized document of its own. The panel as
// APP chrome (it survives a navigation, it keeps one thread per project, it is
// reachable everywhere) is e2e/assistant-chrome.spec.js.

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
  starterPrompt: 'Summarize the parts of speech used across the corpus.',
});
