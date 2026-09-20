// Where "set this project up for UMR" is allowed to happen: at the project
// door, and only when the maintainer asks for it. The door used to redirect to
// a setup page whose only control was one button, and the project list is
// every project the reader can see, so opening one to look inside must not
// write layers into somebody else's project.
//
// Two cases, and the notice has to tell them apart: a project with a substrate
// (text, sentences, words) is adopted, and a project without one has nothing
// for this app to add, text and tokens being made in IGT or UD.
import { test, expect, seedAuth } from './fixtures.js';
import { readToken } from './fixtures.js';
import PlaidClient from '@larc-iu/plaid-client';
import { PLAID_NAMESPACE, ROLE_KEY, ROLES } from '@larc-iu/plaid-client';

const BASE_URL = 'http://localhost:8085';

const newClient = () => new PlaidClient(BASE_URL, readToken().token);

// A project shaped the way IGT and UD leave one: baseline text, sentences,
// words, and nothing of UMR's.
const seedSubstrate = async (client, name) => {
  const project = await client.projects.create(name);
  const text = await client.textLayers.create(project.id, 'Text');
  await client.textLayers.setConfig(text.id, PLAID_NAMESPACE, ROLE_KEY, ROLES.BASELINE);
  const sentences = await client.tokenLayers.create(text.id, 'Sentences', 'partitioning');
  await client.tokenLayers.setConfig(sentences.id, PLAID_NAMESPACE, ROLE_KEY, ROLES.SENTENCE);
  const words = await client.tokenLayers.create(
    text.id,
    'Main Tokens',
    'non-overlapping',
    sentences.id,
  );
  await client.tokenLayers.setConfig(words.id, PLAID_NAMESPACE, ROLE_KEY, ROLES.WORD);
  return project;
};

test('a project with a substrate is set up from the door, on a click', async ({ page }) => {
  const client = newClient();
  const name = `E2E UMR Adopt ${Date.now()}`;
  const project = await seedSubstrate(client, name);
  try {
    await seedAuth(page);
    await page.goto(`/#/projects/${project.id}/documents`);
    await expect(page.getByText('Not set up for UMR')).toBeVisible();
    // Looking is not writing: still on the document list, still no UMR layers.
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/documents$`));
    const untouched = await client.projects.get(project.id);
    expect(untouched.textLayers[0].tokenLayers).toHaveLength(2);

    await page.getByRole('button', { name: 'Set up for UMR' }).click();
    await expect(page.getByRole('heading', { name: `Documents in ${name}` })).toBeVisible();
    const configured = await client.projects.get(project.id);
    const nodes = configured.textLayers[0].tokenLayers.find((t) => t.config?.umr?.nodes === true);
    expect(nodes).toBeTruthy();
    expect(nodes.spanLayers[0].relationLayers).toHaveLength(2);
  } finally {
    await client.projects.delete(project.id);
  }
});

test('a project with no text says so and points at the app that makes some', async ({ page }) => {
  const client = newClient();
  const project = await client.projects.create(`E2E UMR Bare ${Date.now()}`);
  try {
    await seedAuth(page);
    await page.goto(`/#/projects/${project.id}/documents`);
    await expect(page.getByText('No text to annotate')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up for UMR' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open in Plaid UD' })).toBeVisible();
  } finally {
    await client.projects.delete(project.id);
  }
});
