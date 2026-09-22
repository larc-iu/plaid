import { test, expect, seedAuth } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { assistantPanelHarness, assistantPanelTests } from '../../plaid-ui/e2e/assistantPanel.js';

// The assistant panel while a document is open.
//
// The turn itself is not exercised here: that needs a model, and what can go
// wrong in the UI does not. An assistant is made to look online by answering
// the discovery call, which is one GET.
//
// The dock is one component in plaid-ui, so every test about IT is there too
// (`assistantPanelTests`), driven with this app's screens. The panel as APP
// chrome (it survives a navigation, it keeps one thread per project, it is
// reachable everywhere) is e2e/assistant-chrome.spec.js.
//
// Nothing here writes, so it runs on the shared fixture rather than seeding a
// project of its own: the services call is intercepted and the panel's state
// is the browser's.

const S = {};

test.beforeAll(async () => {
  Object.assign(S, await getFixture());
});

const panel = assistantPanelHarness({
  app: 'umr',
  expect,
  documentPath: () => `/#/projects/${S.projectId}/documents/${S.documentId}/annotate`,
  contentSelector: '.umr-canvas',
});

assistantPanelTests({
  test,
  expect,
  seedAuth,
  panel,
  documentName: 'english_umr-0001',
  // This app has no per-sentence gesture: the panel is opened from the header
  // and a sentence is named by `@`. The two tests about "Ask" are not
  // registered.
  ask: null,
  // The project tab goes with the panel, though its route still works.
  alsoHidden: async (page) => {
    await page.goto(`/#/projects/${S.projectId}/documents`);
    await expect(page.getByRole('tab', { name: 'Documents' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Assistant' })).toHaveCount(0);
  },
  starterPrompt: 'Summarize the concepts used across the corpus.',
});
