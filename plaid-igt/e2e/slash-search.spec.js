import { test, expect, seedAuth } from './fixtures.js';
import { getFixture } from './fixtureProject.js';

// `/` outside a text box focuses the screen's search box, and inside one it is
// a slash. Runs against "E2E IGT Fixture" and writes nothing.

let projectId;

test.beforeAll(async () => {
  ({ projectId } = await getFixture());
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
