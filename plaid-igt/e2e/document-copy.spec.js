import { test, expect, seedAuth } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { freshDoc, cleanupDoc, wavBytes } from './bugbash/harness.mjs';

// Copy document on the Details tab, of a document with a recording. The copy
// takes the recording, and when the server could not copy it the page says
// so (H2-6-1): the copy's answer never says, so the page reads the copy.

let ctx;
const made = [];

test.beforeAll(async () => {
  const { client, projectId } = await getFixture();
  const { documentId } = await freshDoc(client, projectId, {
    body: 'the quick brown fox',
    name: `Copy Test ${Date.now()}`,
  });
  await client.documents.uploadMedia(
    documentId,
    new File([wavBytes(2)], 'copy-test.wav', { type: 'audio/wav' }),
  );
  ctx = { client, projectId, documentId };
});

test.afterAll(async () => {
  if (!ctx) return;
  for (const id of made) await cleanupDoc(ctx.client, id).catch(() => {});
  await cleanupDoc(ctx.client, ctx.documentId);
});

async function copy(page, name) {
  await seedAuth(page);
  await page.goto(`/#/projects/${ctx.projectId}/documents/${ctx.documentId}`);
  await page.getByRole('tab', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Copy document' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input').first().fill(name);
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByText(`Copied to “${name}”`)).toBeVisible({ timeout: 15000 });
  const docs = await ctx.client.projects.listDocuments(ctx.projectId);
  const copied = docs.find((d) => d.name === name);
  if (copied) made.push(copied.id);
  return copied;
}

test('a copy takes the recording and says nothing more', async ({ page }) => {
  const name = `Copy with recording ${Date.now()}`;
  const copied = await copy(page, name);
  expect(copied).toBeTruthy();
  expect((await ctx.client.documents.get(copied.id)).mediaUrl).toBeTruthy();
  await expect(page.getByText('The recording was not copied.')).toHaveCount(0);
});

test('a copy whose recording did not come across says so', async ({ page }) => {
  // The server's media copy failing (a full disk, a permission) is stood in
  // for by the copy's read coming back without its recording.
  await page.route(
    (url) => /\/api\/v1\/documents\/[^/?]+$/.test(url.pathname),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'GET' || request.url().includes(ctx.documentId)) {
        return route.continue();
      }
      try {
        const response = await route.fetch();
        const body = JSON.parse(await response.text());
        delete body['document/media-url'];
        return await route.fulfill({ response, json: body });
      } catch {
        // A read the page dropped as it moved on.
        return undefined;
      }
    },
  );
  const copied = await copy(page, `Copy without recording ${Date.now()}`);
  expect(copied).toBeTruthy();
  await expect(page.getByText('The recording was not copied.')).toBeVisible();
});
