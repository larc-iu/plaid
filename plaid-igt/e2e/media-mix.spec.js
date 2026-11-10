import { test, expect, seedAuth, collectClientErrors } from './fixtures.js';
import { freshDoc, cleanupDoc } from './bugbash/harness.mjs';
import { getFixture } from './fixtureProject.js';

// Several files chosen under Per speaker on the Media tab (several on Single
// are refused) are mixed in the browser into one
// recording with a channel each: the mix dialog takes a speaker per file, the upload lands with channelSpeakers, and the tab then
// shows the channel list (speaker, Mute, Solo), one waveform lane per channel,
// and speech detection with a box per channel whose proposals carry the
// channel's speaker. Runs against a THROWAWAY document in the fixture project.
//
// A plain stereo recording is the other case: no channel list, one lane, the
// element plays on its own (never routed into Web Audio). One file with a
// channel per speaker, chosen under Per speaker, goes up as it is with a
// speaker per channel, and Remove speakers per channel makes it plain again.
//
// B66_SHOTS names a directory to put screenshots in (the browser check).

let ctx;

test.beforeAll(async () => {
  // The fixture project, built where the database lacks it.
  const { client, projectId } = await getFixture();
  const { documentId } = await freshDoc(client, projectId, {
    body: '',
    name: `UI Media Mix Test ${Date.now()}`,
  });
  ctx = { client, projectId, documentId };
});

test.afterAll(async () => {
  if (ctx) await cleanupDoc(ctx.client, ctx.documentId);
});

// A 16-bit PCM WAV of `seconds` at `rate` with speech-like bursts (a harmonic
// buzz pulsed at a syllable rate) over `bursts` = [[from, to], ...] in
// seconds, silence elsewhere. Stereo when `channels` is 2, the same on both.
function speechLikeWav({ seconds, rate = 16000, bursts, channels = 1 }) {
  const frames = Math.floor(seconds * rate);
  const blockAlign = channels * 2;
  const dataSize = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    let v = 0;
    if (bursts.some(([a, b]) => t >= a && t < b)) {
      const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
      for (let h = 1; h <= 12; h += 1) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      // Pulsed like syllables, with a little noise.
      v *= 0.5 + 0.5 * Math.max(0, Math.sin(2 * Math.PI * 4 * t));
      v = v * 0.25 + (Math.random() - 0.5) * 0.02;
    }
    const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    for (let c = 0; c < channels; c += 1) buf.writeInt16LE(s, 44 + i * blockAlign + c * 2);
  }
  return buf;
}

// Counts the media elements routed into Web Audio, as window.__routed.
const countRouting = () => {
  window.__routed = 0;
  const proto = window.AudioContext?.prototype;
  if (!proto) return;
  const original = proto.createMediaElementSource;
  proto.createMediaElementSource = function (...args) {
    window.__routed += 1;
    return original.apply(this, args);
  };
};

const shot = async (page, name) => {
  if (process.env.B66_SHOTS) {
    await page.screenshot({ path: `${process.env.B66_SHOTS}/${name}.png`, fullPage: true });
  }
};

async function openMedia(page) {
  await page.goto(`/#/projects/${ctx.projectId}/documents/${ctx.documentId}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Media' }).click();
}

test('two files go through the mix dialog and come out as one recording with a channel list', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const diag = collectClientErrors(page);
  await seedAuth(page);
  await openMedia(page);
  await expect(page.getByText('Upload media file')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose media file', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Single' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await shot(page, '00-single');

  // Ana speaks from 1 to 3 s, Ben (a stereo file) from 4 to 6.5 s.
  const ana = {
    name: 'ana.wav',
    mimeType: 'audio/wav',
    buffer: speechLikeWav({ seconds: 8, bursts: [[1, 3]] }),
  };
  const benStereo = {
    name: 'ben.wav',
    mimeType: 'audio/wav',
    buffer: speechLikeWav({ seconds: 7, bursts: [[4, 6.5]], channels: 2 }),
  };

  // Two files dropped on Single are refused: nothing is mixed unasked. (The
  // picker there takes one file.)
  const dropped = await page.evaluateHandle(
    (files) => {
      const dt = new DataTransfer();
      for (const f of files) {
        dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'audio/wav' }));
      }
      return dt;
    },
    [ana, benStereo].map((f) => ({ name: f.name, bytes: [...f.buffer.subarray(0, 64)] })),
  );
  await page
    .getByText('Upload media file')
    .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    .dispatchEvent('drop', { dataTransfer: dropped });
  await expect(
    page.getByText('One file at a time. For a file per speaker, switch to Per speaker.'),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Mix recordings' })).toHaveCount(0);

  // Per speaker takes several.
  await page.getByRole('button', { name: 'Per speaker' }).click();
  await expect(page.getByRole('button', { name: 'Choose media files' })).toBeVisible();
  await shot(page, '00-per-speaker');
  await page.locator('input[type="file"]').setInputFiles([ana, benStereo]);

  const dialog = page.getByRole('dialog', { name: 'Mix recordings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('0:08.000 · mono · 16 kHz')).toBeVisible({ timeout: 15000 });
  await expect(dialog.getByText('0:07.000 · stereo, mixed to one channel · 16 kHz')).toBeVisible();
  await expect(dialog.getByText('Full quality (16 kHz)')).toBeVisible();
  await dialog.getByLabel('ana.wav speaker').fill('Ana');
  await dialog.getByLabel('ben.wav speaker').fill('Ben');
  await shot(page, '01-mix-dialog');
  await dialog.getByRole('button', { name: 'Upload' }).click();

  // The recording is there: the player, the channel list, two lanes.
  await expect(page.getByText('Timeline', { exact: true })).toBeVisible({ timeout: 30000 });
  const list = page.locator('[data-channel-list]');
  await expect(list).toBeVisible({ timeout: 15000 });
  await expect(list.getByLabel('Ana speaker')).toHaveValue('Ana');
  await expect(list.getByLabel('Ben speaker')).toHaveValue('Ben');
  await expect(page.locator('canvas[data-waveform-lane]')).toHaveCount(2, { timeout: 20000 });
  await shot(page, '02-channel-list-and-lanes');

  // The document carries the list, and the file the server holds is the mix.
  const doc = await ctx.client.documents.get(ctx.documentId);
  expect(doc.metadata.channelSpeakers).toEqual(['Ana', 'Ben']);
  const upload = diag.apiCalls.find((c) => c.method === 'PUT' && /\/media(\?|$)/.test(c.url));
  expect(upload?.status).toBeLessThan(400);

  // Mute and Solo say their state. Solo on Ben, then off again.
  await list.getByLabel('Mute Ana').click();
  await expect(list.getByLabel('Mute Ana')).toHaveAttribute('aria-pressed', 'true');
  await list.getByLabel('Solo Ben').click();
  await expect(list.getByLabel('Solo Ben')).toHaveAttribute('aria-pressed', 'true');
  await shot(page, '03-mute-solo');
  await list.getByLabel('Solo Ben').click();
  await list.getByLabel('Mute Ana').click();

  // Playback still moves through the Web Audio route.
  await page.getByRole('button', { name: 'Skip forward 5 seconds' }).click();
  await expect(page.getByText(/to 0:05\.000 \(playback\)/)).toBeVisible({ timeout: 15000 });

  // A speaker renamed on a channel is written to the document.
  const ben = list.getByLabel('Ben speaker');
  await ben.fill('Benjamin');
  await ben.press('Enter');
  await expect
    .poll(async () => (await ctx.client.documents.get(ctx.documentId)).metadata.channelSpeakers, {
      timeout: 15000,
    })
    .toEqual(['Ana', 'Benjamin']);
  await expect(list.getByLabel('Mute Benjamin')).toBeVisible();

  const realFailures = diag.failures.filter((f) => !/\/media(\?|$)/.test(f.url || ''));
  expect.soft(realFailures, 'no unexpected API failures').toEqual([]);
});

test('speech detection lists the channels and labels each proposal with its speaker', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seedAuth(page);
  await openMedia(page);
  await expect(page.locator('[data-channel-list]')).toBeVisible({ timeout: 20000 });

  await page.getByRole('button', { name: 'Detect speech' }).click();
  const dialog = page.getByRole('dialog', { name: 'Speech detection' });
  await expect(dialog).toBeVisible();
  const boxes = dialog.locator('[data-channel-checklist] input[type=checkbox]');
  await expect(boxes).toHaveCount(2);
  await expect(dialog.getByText('Ana', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Benjamin', { exact: true })).toBeVisible();
  await shot(page, '04-detect-dialog');

  // The built-in model: its wasm and weights come from the dev server.
  await dialog.getByRole('button', { name: 'Detect', exact: true }).click();
  await expect(dialog.getByText(/proposed segment|No speech found|No proposals left/)).toBeVisible({
    timeout: 150_000,
  });
  const summary = await dialog
    .getByText(/proposed segment|No speech found|No proposals left/)
    .textContent();
  console.log('detection summary:', summary);
  await dialog.getByRole('button', { name: 'Close Speech detection' }).click();
  await shot(page, '05-proposals');

  // Every proposal carries the speaker of the channel it was heard on.
  const rows = page.locator('[data-vad-proposal-row]');
  const count = await rows.count();
  console.log('proposal rows:', count);
  for (let i = 0; i < count; i += 1) {
    const speaker = await rows.nth(i).locator('input[list]').inputValue();
    expect(['Ana', 'Benjamin']).toContain(speaker);
  }
  // With speech at 1 to 3 s on Ana's channel and 4 to 6.5 s on Benjamin's, a
  // proposal before 3.5 s is Ana's and one after is Benjamin's.
  for (let i = 0; i < count; i += 1) {
    const at = Number(await rows.nth(i).getAttribute('data-row-time'));
    const speaker = await rows.nth(i).locator('input[list]').inputValue();
    expect(speaker).toBe(at < 3.5 ? 'Ana' : 'Benjamin');
  }
});

test('a plain stereo recording plays as it is, with nothing extra on the Media tab', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { documentId } = await freshDoc(ctx.client, ctx.projectId, {
    body: '',
    name: `UI Media Stereo Test ${Date.now()}`,
  });
  try {
    await page.addInitScript(countRouting);
    await seedAuth(page);
    await page.goto(`/#/projects/${ctx.projectId}/documents/${documentId}`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: 'Media' }).click();
    await expect(page.getByText('Upload media file')).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'interview.wav',
      mimeType: 'audio/wav',
      buffer: speechLikeWav({ seconds: 6, bursts: [[1, 3]], channels: 2 }),
    });

    // One lane, no channel list, nothing in the header about channels.
    await expect(page.getByText('Timeline', { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({
      timeout: 15000,
    });
    await expect(page.locator('[data-channel-list]')).toHaveCount(0);
    await expect(page.locator('canvas[data-waveform-lane]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /per channel/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    expect(await page.evaluate(() => window.__routed)).toBe(0);
    await shot(page, '06-plain-stereo');

    // Speech detection runs on the whole recording: no channel boxes.
    await page.getByRole('button', { name: 'Detect speech' }).click();
    const detect = page.getByRole('dialog', { name: 'Speech detection' });
    await expect(detect).toBeVisible();
    await expect(detect.locator('[data-channel-checklist]')).toHaveCount(0);
    await detect.getByRole('button', { name: 'Close Speech detection' }).click();
    expect((await ctx.client.documents.get(documentId)).metadata?.channelSpeakers).toBeUndefined();
  } finally {
    await cleanupDoc(ctx.client, documentId);
  }
});

test('one file with a channel per speaker goes up as it is under Per speaker, and back to plain', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { documentId } = await freshDoc(ctx.client, ctx.projectId, {
    body: '',
    name: `UI Media Channels Test ${Date.now()}`,
  });
  try {
    await page.addInitScript(countRouting);
    const diag = collectClientErrors(page);
    await seedAuth(page);
    await page.goto(`/#/projects/${ctx.projectId}/documents/${documentId}`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: 'Media' }).click();
    await page.getByRole('button', { name: 'Per speaker' }).click();
    const input = page.locator('input[type="file"]');

    // A mono file has no channels to name.
    await input.setInputFiles({
      name: 'mono.wav',
      mimeType: 'audio/wav',
      buffer: speechLikeWav({ seconds: 2, bursts: [[0.5, 1]] }),
    });
    const dialog = page.getByRole('dialog', { name: 'Speakers per channel' });
    await expect(
      dialog.getByText(
        'One channel. Choose two or more files, or a file with a channel per speaker.',
      ),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Upload' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // A stereo file with a speaker per channel: no mix, a speaker each.
    await input.setInputFiles({
      name: 'interview.wav',
      mimeType: 'audio/wav',
      buffer: speechLikeWav({ seconds: 6, bursts: [[1, 3]], channels: 2 }),
    });
    await expect(dialog.getByText('2 channels')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Mix recordings' })).toHaveCount(0);
    await dialog.getByLabel('Channel 1 speaker').fill('Ana');
    await dialog.getByLabel('Channel 2 speaker').fill('Ben');
    // The dialog's open animation is over before the picture.
    await expect(dialog).toHaveCSS('opacity', '1');
    await shot(page, '07-speakers-per-channel');
    await dialog.getByRole('button', { name: 'Upload' }).click();

    const list = page.locator('[data-channel-list]');
    await expect(list).toBeVisible({ timeout: 30000 });
    await expect(list.getByLabel('Ana speaker')).toHaveValue('Ana');
    await expect(list.getByLabel('Ben speaker')).toHaveValue('Ben');
    await expect(page.locator('canvas[data-waveform-lane]')).toHaveCount(2, { timeout: 20000 });
    await expect.poll(() => page.evaluate(() => window.__routed)).toBe(1);
    const doc = await ctx.client.documents.get(documentId);
    expect(doc.metadata.channelSpeakers).toEqual(['Ana', 'Ben']);
    // The file went up as it was, not as a mix.
    const upload = diag.apiCalls.find((c) => c.method === 'PUT' && /\/media(\?|$)/.test(c.url));
    expect(upload?.status).toBeLessThan(400);
    await shot(page, '08-channel-file-uploaded');

    // And back: no list, one lane, nothing stored.
    await list.getByRole('button', { name: 'Remove speakers per channel' }).click();
    await expect(page.locator('[data-channel-list]')).toHaveCount(0);
    await expect(page.locator('canvas[data-waveform-lane]')).toHaveCount(0, { timeout: 20000 });
    await expect
      .poll(async () => (await ctx.client.documents.get(documentId)).metadata?.channelSpeakers, {
        timeout: 15000,
      })
      .toBeUndefined();
  } finally {
    await cleanupDoc(ctx.client, documentId);
  }
});
