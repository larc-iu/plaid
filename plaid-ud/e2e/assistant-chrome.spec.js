import PlaidClient from '@larc-iu/plaid-client';
import { randomUUID } from 'node:crypto';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { seedUdDoc } from './seedUdDoc.js';
import { assistantHarness, assistantChromeTests } from '../../plaid-ui/e2e/assistantChrome.js';

// The assistant panel as part of the app's chrome rather than one screen's.
//
// This is the property the whole arrangement exists for and the one the older
// panel could not have: the panel is mounted by the shell, so it survives a
// navigation and keeps the conversation the reader was having.
//
// The chrome is one component in plaid-ui, so the thirteen tests that are about
// IT are there too (`assistantChromeTests`), driven with this app's screens.
// What a document screen owes the panel (its height, "Ask", the gutter it
// takes) is e2e/assistant-panel.spec.js. No model and no service: an assistant
// is made to look online by answering the one discovery GET.

const CORE = 'http://localhost:8085';
const SENTENCES = 'the dog runs. she sings.';
const WORDS = [
  [0, 3],
  [4, 7],
  [8, 12],
  [13, 16],
  [17, 22],
];
// Two sentences, so "which one" is a real question: the `@` test picks the
// second by what it SAYS and the reference it writes has to be s2.
const SENTENCE_SPANS = [
  [0, 13],
  [13, 24],
];
const SECOND_DOCUMENT = 'Chrome Spec Second Document';

let projectId;
let documentId;
let otherDocumentId;
let userId;
const seeded = []; // conversation ids to delete

const client = () => new PlaidClient(CORE, readToken().token);

const chrome = assistantHarness({
  app: 'ud',
  expect,
  client,
  userId: () => userId,
  projectId: () => projectId,
  documentPath: (id) => `/#/projects/${projectId}/documents/${id}/annotate`,
  contentSelector: '.sentence-grid',
});
const { dropConversations } = chrome;

// Every seeded conversation is remembered so afterAll can take it away again.
const seedConversation = (title, text, updatedAt) => {
  const id = randomUUID();
  seeded.push(id);
  return chrome.seedConversation({ id, title, text, updatedAt });
};

const crumbs = (page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const tabSeen = (name) => (page) => expect(page.getByRole('tab', { name })).toBeVisible();

// A project of its own, with ONE TOKENIZED DOCUMENT. Not the shared "E2E UD
// Fixture": its Doc 1 carries a text body and no tokens (fixtureProject.js
// never tokenizes it), so the annotation grid every test here waits for could
// never appear. The sibling spec seeds the same way for the same reason.
test.beforeAll(async () => {
  ({ userId } = readToken());
  ({ projectId, documentId } = await seedUdDoc(
    `Assistant chrome ${Date.now()}`,
    SENTENCES,
    WORDS,
    SENTENCE_SPANS,
  ));
  // A second document to walk to. It needs no annotation of its own: what the
  // tests read there is the breadcrumb and the panel beside it.
  otherDocumentId = (await client().documents.create(projectId, SECOND_DOCUMENT)).id;
});

// A seeded project left on the dev core is not inert: search.spec.js takes the
// first configured project that has tokens, so leftovers make it query a
// treebank with no dependency relations in it and fail.
test.afterAll(async () => {
  await dropConversations(seeded, [projectId]);
  if (projectId) {
    await client()
      .projects.delete(projectId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const documentsTab = {
  path: () => `/#/projects/${projectId}/documents`,
  seen: tabSeen('Documents'),
};

const searchTab = {
  path: () => `/#/projects/${projectId}/search`,
  seen: tabSeen('Search'),
};

assistantChromeTests({
  test,
  expect,
  seedAuth,
  chrome,
  documentId: () => documentId,
  secondDocument: {
    path: () => `/#/projects/${projectId}/documents/${otherDocumentId}/annotate`,
    // It has no annotation of its own, so what says it has arrived is the
    // breadcrumb.
    seen: (page) => expect(crumbs(page)).toContainText(SECOND_DOCUMENT),
  },
  projectScreen: documentsTab,
  elsewhere: searchTab,
  // /profile is about the person, not a project: none is in scope there at all.
  projectlessScreen: {
    path: () => '/#/profile',
    seen: (page) => expect(page.getByText('User Profile')).toBeVisible(),
  },
  assistantTab: {
    path: () => `/#/projects/${projectId}/assistant`,
    seen: tabSeen('Assistant'),
  },
  screensWithControl: [documentsTab, searchTab],
  mention: {
    typed: 'about @sings',
    shows: 'she sings',
    inserts: 'about s2 ',
  },
  projectName: () => 'E2E UD Fixture',
  ask: {
    // The grid is React and repaints on a resize, so nothing has to be
    // reloaded to read it.
    hide: (page) => expect(page.getByRole('button', { name: 'Ask' })).toHaveCount(0),
    show: async () => {},
  },
  seedConversation,
});
