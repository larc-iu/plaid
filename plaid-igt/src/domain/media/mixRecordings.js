// Mixing several recordings, one per speaker, into one multichannel WAV in
// the browser. A long recording decodes to gigabytes, so only one decoded
// file is held at a time. Each file is read once at its own rate
// (mediaSampleRate.js reads it from the header, since the decoder resamples
// to whatever it is asked for) for its length and channels, and only those
// numbers are kept, so the dialog can say what each file is before the
// quality is chosen. The mix decodes each file again at the chosen rate,
// writes it into the WAV on the common clock (mixdown.js) and drops it before
// the next. Nothing about the offsets is kept once the file is made.

import { readSampleRate } from './mediaSampleRate.js';
import { readWavInfo } from './wavAdpcm.js';
import { FALLBACK_RATE, emptyWav, mixName, mixRate, mixSeconds, writeChannel } from './mixdown.js';

const OfflineCtx = () =>
  typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);

// The decodes wait their turn here, one at a time across every dialog, and
// `use` runs inside the turn, so a decode left over from a closed dialog is
// gone before the next one starts. A turn whose signal is aborted is skipped.
let turn = Promise.resolve();
function withDecoded(file, rate, signal, use) {
  const run = turn.then(async () => {
    signal?.throwIfAborted();
    const Ctx = OfflineCtx();
    if (!Ctx) throw new Error('This browser has no OfflineAudioContext.');
    const decoded = await new Ctx(1, 1, rate).decodeAudioData(await file.arrayBuffer());
    signal?.throwIfAborted();
    return use(decoded);
  });
  turn = run.catch(() => {});
  return run;
}

/**
 * What `file` is, from the browser's decode at its own rate:
 * `{ name, sampleRate, channels, seconds }`. The samples are not kept.
 * Throws with the browser's own message when the file is not decodable audio,
 * and an AbortError once `signal` is aborted.
 */
export async function readTrack(file, { signal } = {}) {
  const rate = (await readSampleRate(file)) ?? FALLBACK_RATE;
  return withDecoded(file, rate, signal, (decoded) => ({
    name: file.name || 'recording',
    sampleRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
    seconds: decoded.duration,
  }));
}

/**
 * How many channels `file` has: off a WAV's header without decoding it, else
 * from the browser's decode. Throws when the file is not decodable audio.
 */
export async function readChannelCount(file) {
  const read = async (from, to) =>
    new Uint8Array(await file.slice(from, Math.min(to, file.size)).arrayBuffer());
  const info = await readWavInfo(read, file.size).catch(() => null);
  if (info?.channels > 0) return info.channels;
  const Ctx = OfflineCtx();
  if (!Ctx) throw new Error('This browser has no OfflineAudioContext.');
  const decoded = await new Ctx(1, 1, FALLBACK_RATE).decodeAudioData(await file.arrayBuffer());
  return decoded.numberOfChannels;
}

/**
 * Tracks (`readTrack` plus the `file` and an `offset` in seconds each) as one
 * WAV File. Each file is decoded at the mix's rate, written in and dropped
 * before the next is read. `onProgress(index, total)` is told before each
 * track. Stops with an AbortError once `signal` is aborted.
 */
export async function mixTracks(tracks, { quality = 'full', onProgress, signal } = {}) {
  const rate = mixRate(tracks, quality);
  const frames = Math.ceil(mixSeconds(tracks) * rate);
  const bytes = emptyWav(tracks.length, frames, rate);
  for (const [i, track] of tracks.entries()) {
    onProgress?.(i, tracks.length);
    await withDecoded(track.file, rate, signal, (decoded) => {
      const sources = Array.from({ length: decoded.numberOfChannels }, (_, c) =>
        decoded.getChannelData(c),
      );
      writeChannel(bytes, i, sources, track.offset);
    });
  }
  onProgress?.(tracks.length, tracks.length);
  return new File([bytes], mixName(tracks[0].name, tracks.length), { type: 'audio/wav' });
}

/**
 * Files straight to a mix: `[{file, offset}]` read and mixed, for a path
 * with no dialog between the two (an ELAN import). `onProgress(step)` is
 * told what is happening, as "Decoding ana.wav" or "Writing the mix".
 */
export async function mixFiles(entries, { quality = 'full', onProgress, read = readTrack } = {}) {
  const tracks = [];
  for (const { file, offset } of entries) {
    onProgress?.(`Decoding ${file.name}`);
    tracks.push({ ...(await read(file)), file, offset: offset || 0 });
  }
  onProgress?.('Writing the mix');
  return mixTracks(tracks, { quality });
}
