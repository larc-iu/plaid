import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';

// `/` outside a text box focuses the screen's search box, and inside one it is
// a slash. Runs against "E2E IGT Fixture" and writes nothing.

const CORE = 'http://localhost:8085';

let projectId;

test.beforeAll(async () => {
  const client = new PlaidClient(CORE, readToken().token);
  const projects = await client.projects.list();
  const fixture = projects.find((p) => p.name === 'E2E IGT Fixture');
  if (!fixture) throw new Error('run node e2e/fixtureProject.js first');
  projectId = fixture.id;
});

test('/ focuses the document list search, and is typed as itself inside a box', async ({
  page,
}) => {
  await seedAuth(page);
  await page.goto(`/#/projects/${projectId}`);
  const search = page.getByRole('textbox', { name: /^Search/ }).first();
  await expect(search).toBeVisible({ timeout: 15000 });
  await expect(search).not.toBeFocused();
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await page.keyboard.type('a/b');
  await expect(search).toHaveValue('a/b');
});
