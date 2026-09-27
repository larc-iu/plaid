import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { createUmrProject } from '../src/domain/umrProjectSetup.js';
import { assistantProjectsTests } from '../../plaid-ui/e2e/assistantProjects.js';

// A conversation that reads other projects beside its own: plaid-igt's
// assistant-projects spec, driven with this app's Assistant tab and citation
// card. The tests are shared (plaid-ui/e2e/assistantProjects.js).

const CORE = 'http://localhost:8085';
const client = () => new PlaidClient(CORE, readToken().token);

const stamp = Date.now();
let home;
let served;
let unserved;

test.beforeAll(async () => {
  const c = client();
  home = (await createUmrProject(c, `E2E Multi home ${stamp}`)).id;
  served = {
    id: (await c.projects.create(`E2E Multi B ${stamp}`)).id,
    name: `E2E Multi B ${stamp}`,
  };
  unserved = {
    id: (await c.projects.create(`E2E Multi C ${stamp}`)).id,
    name: `E2E Multi C ${stamp}`,
  };
});

test.afterAll(async () => {
  const c = client();
  for (const id of [home, served?.id, unserved?.id].filter(Boolean)) {
    await c.projects.delete(id).catch(() => {});
  }
});

assistantProjectsTests({
  test,
  expect,
  seedAuth,
  app: 'umr',
  client,
  userId: () => readToken().userId,
  home: () => home,
  served: () => served,
  unserved: () => unserved,
  assistantPath: (projectId, id) =>
    `/#/projects/${projectId}/assistant${id ? `?conversation=${id}` : ''}`,
  citation: (projectId) => ({
    key: '<cite project="B" doc="Text B" ref="s1"/>',
    projectId,
    documentId: '00000000-0000-4000-8000-00000000000b',
    documentName: 'Text B',
    sentence: 1,
    sentenceId: '00000000-0000-4000-8000-0000000000b1',
    words: [],
    focus: [],
  }),
});
