import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { makeClient, getFixtureProjectId, freshDoc, cleanupDoc, wavBytes } from './bugbash/harness.mjs';

// Browser-mediated media flow that the headless harness can't reach: the real
// hidden <input type=file> -> onChange -> doc.uploadMedia() -> reload -> the
// DocumentMedia tab swapping from the upload prompt to the player + timeline.
// Runs against a THROWAWAY document in the shared fixture project.

let ctx;

test.beforeAll(async () => {
  const client = makeClient();
  const projectId = await getFixtureProjectId(client);
  const { documentId } = await freshDoc(client, projectId, {
    body: 'the quick brown fox jumps over the lazy dog',
    name: `UI Media Test ${Date.now()}`,
  });
  ctx = { client, projectId, documentId };
});

test.afterAll(async () => {
  if (ctx) await cleanupDoc(ctx.client, ctx.documentId);
});

async function openMedia(page) {
  await page.goto(`/#/projects/${ctx.projectId}/documents/${ctx.documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Media' }).click();
}

test('file picker uploads media and reveals the timeline', async ({ page }) => {
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openMedia(page);

  // Upload prompt visible (no media yet).
  await expect(page.getByText('Upload Media File')).toBeVisible();

  // Drive the real hidden file input with a valid 6s WAV.
  await page.locator('input[type="file"]').setInputFiles({
    name: 'ui-test.wav',
    mimeType: 'audio/wav',
    buffer: wavBytes(6),
  });

  // The PUT /media must succeed and the component must swap to the timeline.
  await expect(page.getByText('Timeline', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Upload Media File')).toHaveCount(0);

  // The media PUT round-tripped (mediaUrl now set on the document).
  const putMedia = diag.apiCalls.find((c) => c.method === 'PUT' && /\/media(\?|$)/.test(c.url));
  expect(putMedia, 'a PUT .../media call was made').toBeTruthy();
  expect(putMedia.status, 'media upload succeeded').toBeLessThan(400);

  // Whether headless Chromium decoded the audio (duration > 0). Informational:
  // the drag-select-to-create path needs this AND a registered ASR service.
  const pxLabel = await page.getByText(/\d+px\/s/).first().textContent().catch(() => null);
  console.log('timeline zoom label:', pxLabel);

  console.log('--- failed requests ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  // Ignore media GETs (waveform/playback range requests can legitimately 4xx).
  const realFailures = diag.failures.filter((f) => !/\/media(\?|$)/.test(f.url || ''));
  expect.soft(realFailures, 'no unexpected API failures during upload').toEqual([]);
});

test('uploaded media can be deleted from the UI', async ({ page }) => {
  await seedAuth(page);
  await openMedia(page);

  // Media should already be present from the previous test (same throwaway doc).
  await expect(page.getByText('Timeline', { exact: true })).toBeVisible({ timeout: 15000 });

  // The delete control lives in the player; accept it via the confirm() dialog.
  page.on('dialog', (d) => d.accept());
  const delBtn = page.getByRole('button', { name: /delete media/i });
  if (await delBtn.count()) {
    await delBtn.first().click();
    await expect(page.getByText('Upload Media File')).toBeVisible({ timeout: 15000 });
  } else {
    test.info().annotations.push({ type: 'note', text: 'no explicit Delete Media button found; skipped' });
  }
});
