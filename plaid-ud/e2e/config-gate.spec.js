// Where "set this project up for UD" is allowed to happen: at the project
// door, never on opening a document. Opening a document used to redirect, which
// threw the reader out of the editor mid-task — including on time travel to a
// state that predated the project's layers.
//
// The door does not redirect either any more, and it does not set the project
// up on its own: the project list is every project the reader can see, so
// opening one has to be safe to do. It offers the maintainer a button.
//
// Seeds its own project (bare: no layers at all), reused by name across runs
// the way `fixtureProject.js` does. The test that actually presses the button
// makes a project of its own and deletes it, since a project can only be set
// up once.
import { test, expect } from '@playwright/test';
import PlaidClient from '@larc-iu/plaid-client';
import { readToken, seedAuth } from './fixtures.js';

const PROJECT_NAME = 'E2E UD Unconfigured';
const DOC_NAME = 'Doc 1';
const BASE_URL = 'http://localhost:8085';

let projectId;
let documentId;

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient(BASE_URL, token);
  const existing = (await client.projects.list()).find((p) => p.name === PROJECT_NAME);
  const project = existing || (await client.projects.create(PROJECT_NAME));
  projectId = project.id;
  const docs = await client.projects.listDocuments(projectId);
  documentId = (
    docs.find((d) => d.name === DOC_NAME) || (await client.documents.create(projectId, DOC_NAME))
  ).id;
});

test.beforeEach(async ({ page }) => {
  await seedAuth(page);
});

test('clicking into an unconfigured project offers setup where it stands', async ({ page }) => {
  await page.goto(`/#/projects/${projectId}/documents`);
  await expect(page.getByText('Not set up for UD')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up for UD' })).toBeVisible();
  // Looking is not writing: no redirect, and no layers made by arriving.
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/documents$`));
  const { token } = readToken();
  const client = new PlaidClient(BASE_URL, token);
  expect((await client.projects.get(projectId)).textLayers || []).toHaveLength(0);
});

test('the button sets the project up and the document list appears', async ({ page }) => {
  const { token } = readToken();
  const client = new PlaidClient(BASE_URL, token);
  const name = `E2E UD Adopt ${Date.now()}`;
  const project = await client.projects.create(name);
  try {
    await page.goto(`/#/projects/${project.id}/documents`);
    await page.getByRole('button', { name: 'Set up for UD' }).click();
    await expect(page.getByRole('heading', { name: `Documents in ${name}` })).toBeVisible();
    const configured = await client.projects.get(project.id);
    const textLayer = configured.textLayers[0];
    expect(textLayer.config.plaid.role).toBe('baseline');
    expect(textLayer.tokenLayers.map((t) => t.config.plaid.role).sort()).toEqual([
      'sentence',
      'syntactic-word',
      'word',
    ]);
  } finally {
    await client.projects.delete(project.id);
  }
});

test('a document opened directly says so and offers the way, without redirecting', async ({
  page,
}) => {
  await page.goto(`/#/projects/${projectId}/documents/${documentId}/annotate`);
  await expect(page.getByText('Not set up for UD')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Set up its layers' })).toBeVisible();
  // The point of the change: it stays put instead of bouncing the reader out.
  await expect(page).toHaveURL(new RegExp(`/documents/${documentId}/annotate$`));
});
