import PlaidClient from '@larc-iu/plaid-client';
import { randomUUID } from 'node:crypto';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { assistantHarness, assistantChromeTests } from '../../plaid-ui/e2e/assistantChrome.js';

// The assistant panel as part of the app's chrome rather than one screen's.
//
// This is the property the whole arrangement exists for: the panel is mounted
// by the shell, so it survives a navigation and keeps the conversation the
// reader was having. UMR mounts the same shell as the other apps and nothing
// drove it here.
//
// The chrome is one component in plaid-ui, so the tests that are about IT are
// there too (`assistantChromeTests`), driven with this app's screens. No model
// and no service: an assistant is made to look online by answering the one
// discovery GET, and a conversation is written straight into the user's own
// key/value store.

const CORE = 'http://localhost:8085';
const SECOND_DOCUMENT = 'Chrome Spec Second Document';

let projectId;
let documentId;
let otherDocumentId;
let userId;
const seeded = []; // conversation ids to delete

const client = () => new PlaidClient(CORE, readToken().token);

const chrome = assistantHarness({
  app: 'umr',
  expect,
  client,
  userId: () => userId,
  projectId: () => projectId,
  documentPath: (id) => `/#/projects/${projectId}/documents/${id}/annotate`,
  contentSelector: '.umr-canvas',
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

// The shared fixture, plus one empty document to walk to. Both the document and
// the conversations are taken away again: the fixture project is what every
// other spec in this suite reads.
test.beforeAll(async () => {
  ({ userId } = readToken());
  ({ projectId, documentId } = await getFixture());
  otherDocumentId = (await client().documents.create(projectId, SECOND_DOCUMENT)).id;
});

test.afterAll(async () => {
  await dropConversations(seeded, [projectId]);
  if (otherDocumentId) {
    await client()
      .documents.delete(otherDocumentId)
      .catch((e) => console.error('cleanup failed:', e.message));
  }
});

const documentsTab = {
  path: () => `/#/projects/${projectId}/documents`,
  seen: tabSeen('Documents'),
};

const guidelinesTab = {
  path: () => `/#/projects/${projectId}/guidelines`,
  seen: tabSeen('Guidelines'),
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
  elsewhere: guidelinesTab,
  // /profile is about the person, not a project: none is in scope there at all.
  projectlessScreen: {
    path: () => '/#/profile',
    seen: (page) => expect(page.getByText('User Profile')).toBeVisible(),
  },
  assistantTab: {
    path: () => `/#/projects/${projectId}/assistant`,
    seen: tabSeen('Assistant'),
  },
  screensWithControl: [documentsTab, guidelinesTab],
  mention: {
    typed: 'about @Philippines',
    shows: 'Philippines',
    inserts: 'about s1 ',
  },
  projectName: () => 'E2E UMR Fixture',
  // No per-sentence gesture in this app, so there is nothing for a narrow
  // viewport to hide.
  ask: { hide: async () => {}, show: async () => {} },
  seedConversation,
});
