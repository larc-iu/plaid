import PlaidClient from '@larc-iu/plaid-client';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createUmrProject } from '../src/domain/umrProjectSetup.js';
import { importUmrDocument } from '../src/domain/umrImport.js';
import { getUmrLayerInfo } from '../src/utils/umrLayerUtils.js';
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

const SECOND_DOCUMENT = 'Chrome Spec Second Document';

// The English sample's first sentence (the one naming the Philippines), as a
// document of one sentence: the whole sample takes seconds to open on a busy
// machine, and these tests open a document again and again.
const SAMPLE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);
const SEPARATOR = '#'.repeat(80);
const firstSentence = () => {
  const blocks = fs.readFileSync(SAMPLE, 'utf8').split(SEPARATOR);
  return `${SEPARATOR}${blocks[1]}`;
};

let projectName;
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

const tabSeen = (name) => (page) => expect(page.getByRole('tab', { name })).toBeVisible();

// A project of its own, made for this run, with the one-sentence document and
// an empty one to walk to. Not the shared "E2E UMR Fixture": another worker
// running this spec at the same time would share its documents and delete
// them under it, and the panel in assistant-panel.spec.js would resume the
// conversations seeded here.
test.beforeAll(async () => {
  ({ userId } = readToken());
  projectName = `Assistant chrome ${process.pid}-${Date.now()}`;
  const c = client();
  projectId = (await createUmrProject(c, projectName)).id;
  const project = await c.projects.get(projectId);
  const sample = await importUmrDocument(
    c,
    projectId,
    'english_umr-0001 s1',
    firstSentence(),
    getUmrLayerInfo(project),
  );
  documentId = sample.document.id;
  otherDocumentId = (await c.documents.create(projectId, SECOND_DOCUMENT)).id;
});

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
    seen: (page) =>
      expect(page.getByRole('heading', { level: 1, name: SECOND_DOCUMENT })).toBeVisible(),
  },
  projectScreen: documentsTab,
  elsewhere: guidelinesTab,
  // /profile is about the person, not a project: none is in scope there at all.
  projectlessScreen: {
    path: () => '/#/profile',
    seen: (page) => expect(page.getByText('User profile')).toBeVisible(),
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
  projectName: () => projectName,
  // No per-sentence gesture in this app, so there is nothing for a narrow
  // viewport to hide.
  ask: { hide: async () => {}, show: async () => {} },
  seedConversation,
});
