import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import {
  makeClient,
  getFixtureProjectId,
  freshDoc,
  cleanupDoc,
  wavBytes,
} from './bugbash/harness.mjs';

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

  // The "?" legend opens and closes from the Recording header.
  const help = page.getByRole('button', { name: 'Keyboard help' });
  await help.click();
  await expect(page.getByRole('region', { name: 'Keyboard help' })).toContainText('Transcript');
  await help.click();
  await expect(page.getByRole('region', { name: 'Keyboard help' })).toHaveCount(0);

  // The media PUT round-tripped (mediaUrl now set on the document).
  const putMedia = diag.apiCalls.find((c) => c.method === 'PUT' && /\/media(\?|$)/.test(c.url));
  expect(putMedia, 'a PUT .../media call was made').toBeTruthy();
  expect(putMedia.status, 'media upload succeeded').toBeLessThan(400);

  // Whether headless Chromium decoded the audio (duration > 0). Informational:
  // the drag-select-to-create path needs this AND a registered ASR service.
  const pxLabel = await page
    .getByText(/\d+px\/s/)
    .first()
    .textContent()
    .catch(() => null);
  console.log('timeline zoom label:', pxLabel);

  console.log('--- failed requests ---');
  for (const f of diag.failures) console.log(JSON.stringify(f));
  // Ignore media GETs (waveform/playback range requests can legitimately 4xx).
  const realFailures = diag.failures.filter((f) => !/\/media(\?|$)/.test(f.url || ''));
  expect.soft(realFailures, 'no unexpected API failures during upload').toEqual([]);
});

test('the transcript adds a segment at the playhead and Enter saves an edit', async ({ page }) => {
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openMedia(page);
  await expect(page.getByText('Timeline', { exact: true })).toBeVisible({ timeout: 15000 });

  // The flow needs a decoded recording (duration > 0). Headless Chromium decodes
  // the 6s WAV; if it ever does not, say so instead of failing on a hint string.
  await page.getByRole('button', { name: 'Skip forward 5 seconds' }).click();
  const hint = page.getByText(/to 0:05\.000 \(playback\)/);
  if (!(await hint.isVisible().catch(() => false))) {
    test.skip(true, 'media did not decode in headless Chromium, so the playhead cannot move');
  }

  // Type what was "heard" and save: the segment runs from 0 to the playhead.
  const fresh = page.getByLabel('New segment text');
  await fresh.fill('hello there');
  await fresh.press('Enter');
  const row = page.getByLabel('Segment 1 text');
  await expect(row).toHaveValue('hello there', { timeout: 15000 });
  await expect(page.getByLabel('Segment 1 start')).toHaveValue('0:00.000');
  await expect(page.getByLabel('Segment 1 end')).toHaveValue('0:05.000');
  await expect(fresh).toHaveValue('');

  // A boundary nudged by keyboard is saved when the field is left, and survives
  // a reload: the patch went to the server, not just the row.
  const end = page.getByLabel('Segment 1 end');
  await end.focus();
  await end.press('ArrowDown');
  await expect(end).toHaveValue('0:04.990');
  await end.press('Tab');
  await expect(end).toHaveValue('0:04.990');
  await openMedia(page);
  await expect(page.getByLabel('Segment 1 end')).toHaveValue('0:04.990', { timeout: 15000 });
  await expect(page.getByLabel('Segment 1 text')).toHaveValue('hello there');

  // Editing the row: Enter saves (the token is recreated) and moves on to the
  // new-segment row, which is the last thing after the last segment.
  const rowAgain = page.getByLabel('Segment 1 text');
  await rowAgain.fill('hello there friend');
  await rowAgain.press('Enter');
  await expect(page.getByLabel('Segment 1 text')).toHaveValue('hello there friend', {
    timeout: 15000,
  });
  await expect(page.getByLabel('New segment text')).toBeFocused();

  const realFailures = diag.failures.filter((f) => !/\/media(\?|$)/.test(f.url || ''));
  expect.soft(realFailures, 'no unexpected API failures during transcription').toEqual([]);
});

test('uploaded media can be deleted from the UI', async ({ page }) => {
  await seedAuth(page);
  await openMedia(page);

  // Media should already be present from the previous test (same throwaway doc).
  await expect(page.getByText('Timeline', { exact: true })).toBeVisible({ timeout: 15000 });

  // The delete control lives in the player and confirms through the app's own
  // dialog (an AlertDialog, not window.confirm), so accept it by its button.
  await page.getByRole('button', { name: 'Delete media file' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Upload Media File')).toBeVisible({ timeout: 15000 });
});
