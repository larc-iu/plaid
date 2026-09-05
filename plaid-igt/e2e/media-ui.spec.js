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
  const start = page.getByRole('group', { name: 'Segment 1 start' });
  const end = page.getByRole('group', { name: 'Segment 1 end' });
  await expect(start).toHaveAttribute('data-value', '0:00.000');
  await expect(end).toHaveAttribute('data-value', '0:05.000');
  await expect(fresh).toHaveValue('');

  // A boundary nudged by keyboard in its milliseconds box is saved when the
  // time is left, and survives a reload: the patch went to the server.
  const endMs = page.getByLabel('Segment 1 end milliseconds');
  await endMs.focus();
  await endMs.press('ArrowDown');
  await expect(end).toHaveAttribute('data-value', '0:04.990');
  await endMs.press('Tab');
  await expect(end).toHaveAttribute('data-value', '0:04.990');
  await openMedia(page);
  await expect(page.getByRole('group', { name: 'Segment 1 end' })).toHaveAttribute(
    'data-value',
    '0:04.990',
    { timeout: 15000 },
  );
  await expect(page.getByLabel('Segment 1 text')).toHaveValue('hello there');

  // A click on the segment in the timeline lands in its transcript row, with
  // no popover in the way, and the page itself does not move: only the
  // transcript's own box may scroll, or the timeline would leave the viewport.
  const pageY = await page.evaluate(() => window.scrollY);
  await page.locator('[title^="hello there"]').click();
  await expect(page.getByLabel('Segment 1 text')).toBeFocused();
  await expect(page.getByText('New segment', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(pageY);

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

test('Shift+Space in a row pauses and plays on from there; only a finished segment starts over', async ({
  page,
}) => {
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openMedia(page);
  const row = page.getByLabel('Segment 1 text');
  await expect(row).toHaveValue('hello there friend', { timeout: 15000 });
  const state = () =>
    page.evaluate(() => {
      const el = document.querySelector('audio, video');
      return el ? { t: el.currentTime, paused: el.paused } : null;
    });
  const paused = async () => (await state())?.paused;

  // Into the row: the segment (0 to 4.99 s) plays from its start.
  await row.focus();
  await page.waitForTimeout(150);
  if (await paused()) await row.press('Shift+Space');
  await expect.poll(paused).toBe(false);
  await page.waitForTimeout(700);

  // Pause mid-segment, then the chord again: playback goes on from where it
  // stopped, never back to the start.
  await row.press('Shift+Space');
  await expect.poll(paused).toBe(true);
  const { t: pausedAt } = await state();
  expect(pausedAt).toBeGreaterThan(0.3);
  expect(pausedAt).toBeLessThan(4);
  await row.press('Shift+Space');
  await expect.poll(paused).toBe(false);
  await page.waitForTimeout(300);
  const { t: resumedAt } = await state();
  expect(resumedAt).toBeGreaterThanOrEqual(pausedAt);
  expect(resumedAt).toBeLessThan(pausedAt + 1.5);

  // It stops at the segment's end; from there the chord starts the segment over.
  await expect.poll(paused, { timeout: 10000 }).toBe(true);
  expect((await state()).t).toBeGreaterThan(4.5);
  await row.press('Shift+Space');
  await expect.poll(paused).toBe(false);
  await page.waitForTimeout(200);
  expect((await state()).t).toBeLessThan(1.5);
  await row.press('Shift+Space');
  await expect.poll(paused).toBe(true);

  const realFailures = diag.failures.filter((f) => !/\/media(\?|$)/.test(f.url || ''));
  expect.soft(realFailures, 'no unexpected API failures during playback').toEqual([]);
});

test('deleting a segment keeps its text, and existing text is aligned by selecting it', async ({
  page,
}) => {
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openMedia(page);
  await expect(page.getByLabel('Segment 1 text')).toHaveValue('hello there friend', {
    timeout: 15000,
  });
  const bodyNow = async () => {
    const fresh = await ctx.client.documents.get(ctx.documentId, true);
    return fresh.textLayers[0].text.body;
  };
  const bodyBefore = await bodyNow();
  expect(bodyBefore).toContain('hello there friend');

  // Delete with the box left alone: the row goes at once, the text stays.
  await page.getByRole('button', { name: 'Delete segment' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Delete segment', exact: true }).click();
  await expect(page.getByLabel('Segment 1 text')).toHaveCount(0);
  await expect(page.getByText(/No segments yet\. Add one/)).toBeVisible();
  await expect.poll(bodyNow).toBe(bodyBefore);
  // The row left before the dialog finished closing (the delete is applied
  // locally first); its overlay must be gone before the mouse goes near the
  // timeline, or the drag lands on the overlay.
  await expect(dialog).toHaveCount(0);

  // Drag a stretch from 1 s to 2 s on the timeline, then choose the words
  // the segment covers from the baseline instead of typing them.
  const pxLabel = await page
    .getByText(/\d+px\/s/)
    .first()
    .textContent();
  const pps = parseInt(pxLabel, 10);
  const track = page.locator('[data-timeline="track"]');
  const box = await track.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1 * pps, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 1.5 * pps, y, { steps: 4 });
  await page.mouse.move(box.x + 2 * pps, y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByText('New segment', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Existing text' }).click();
  const existing = page.getByLabel('Baseline text');
  await expect(existing).toHaveValue(bodyBefore);
  await expect(existing).toHaveAttribute('aria-readonly', 'true');
  await existing.press('x'); // nothing can be typed into it
  await expect(existing).toHaveValue(bodyBefore);
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();

  // Select "the quick brown" from the keyboard, starting inside the first word
  // and stopping inside the last: the selection snaps to whole words.
  await existing.click();
  await existing.press('Control+Home'); // Home alone is the start of the wrapped line
  await existing.press('ArrowRight');
  for (let i = 0; i < 12; i++) await existing.press('Shift+ArrowRight'); // "he quick bro"
  await expect(page.locator('[data-picked-text]')).toContainText('“the quick brown”');
  await expect(save).toBeEnabled();
  await save.click();

  // The segment is over those words, and the baseline did not change.
  await expect(page.getByLabel('Segment 1 text')).toHaveValue('the quick brown', {
    timeout: 15000,
  });
  const start = page.getByRole('group', { name: 'Segment 1 start' });
  await expect(start).toHaveAttribute('data-value', /^0:0[01]\./);
  await expect.poll(bodyNow).toBe(bodyBefore);

  // The opt-in: delete this one WITH its text.
  await page.getByRole('button', { name: 'Delete segment' }).click();
  const again = page.getByRole('alertdialog');
  await again.getByRole('checkbox').check();
  await again.getByRole('button', { name: 'Delete segment and text' }).click();
  await expect(page.getByLabel('Segment 1 text')).toHaveCount(0);
  await expect.poll(bodyNow).toBe(bodyBefore.replace('the quick brown ', ''));

  const realFailures = diag.failures.filter((f) => !/\/media(\?|$)/.test(f.url || ''));
  expect.soft(realFailures, 'no unexpected API failures during delete and align').toEqual([]);
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
