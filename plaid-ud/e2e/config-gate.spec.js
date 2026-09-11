// Where "set this project up for UD" is allowed to happen: at the project
// door, never on opening a document. Opening a document used to redirect, which
// threw the reader out of the editor mid-task — including on time travel to a
// state that predated the project's layers.
//
// Seeds its own project (bare: no layers at all), reused by name across runs
// the way `fixtureProject.js` does.
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

test('clicking into an unconfigured project lands on layer setup', async ({ page }) => {
  await page.goto(`/#/projects/${projectId}/documents`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/configuration$`));
  await expect(page.getByRole('heading', { name: /Configure UD Layers/i })).toBeVisible();
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
