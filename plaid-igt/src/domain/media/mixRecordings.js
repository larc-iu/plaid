// Mixing several recordings, one per speaker, into one multichannel WAV in
// the browser. Each file is decoded once at its own rate (mediaSampleRate.js
// reads it from the header, since the decoder resamples to whatever it is
// asked for) and averaged to one channel, so the dialog can say what each
// file is before the quality is chosen. The mix itself resamples each track
// to the chosen rate, places it on the common clock (mixdown.js) and writes
// the WAV. Nothing about the offsets is kept once the file is made.

import { resampleMono } from '../vad/decodeTo16kMono.js';
import { readSampleRate } from './mediaSampleRate.js';
import {
  FALLBACK_RATE,
  averageChannels,
  encodeWav,
  mixName,
  mixRate,
  mixSeconds,
  placeTrack,
} from './mixdown.js';

const OfflineCtx = () =>
  typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);

/**
 * `file` decoded at its own rate and averaged to one channel:
 * `{ name, sampleRate, channels, seconds, mono }`. Throws with the browser's
 * own message when the file is not decodable audio.
 */
export async function decodeTrack(file) {
  const Ctx = OfflineCtx();
  if (!Ctx) throw new Error('This browser has no OfflineAudioContext.');
  const rate = (await readSampleRate(file)) ?? FALLBACK_RATE;
  const decoded = await new Ctx(1, 1, rate).decodeAudioData(await file.arrayBuffer());
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) =>
    decoded.getChannelData(c),
  );
  return {
    name: file.name || 'recording',
    sampleRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
    seconds: decoded.duration,
    mono: averageChannels(channels),
  };
}

/**
 * Decoded tracks (`decodeTrack` plus an `offset` in seconds each) as one WAV
 * File. `onProgress(index, total)` is told before each track is placed.
 */
export async function mixTracks(tracks, { quality = 'full', onProgress } = {}) {
  const rate = mixRate(tracks, quality);
  const frames = Math.ceil(mixSeconds(tracks) * rate);
  const placed = [];
  for (const [i, track] of tracks.entries()) {
    onProgress?.(i, tracks.length);
    const samples = await resampleMono(track.mono, track.sampleRate, rate);
    placed.push(placeTrack(samples, track.offset, rate, frames));
  }
  onProgress?.(tracks.length, tracks.length);
  return new File([encodeWav(placed, rate)], mixName(tracks[0].name, tracks.length), {
    type: 'audio/wav',
  });
}

/**
 * Files straight to a mix: `[{file, offset}]` decoded and mixed, for a path
 * with no dialog between the two (an ELAN import). `onProgress(step)` is
 * told what is happening, as "Decoding ana.wav" or "Writing the mix".
 */
export async function mixFiles(
  entries,
  { quality = 'full', onProgress, decode = decodeTrack } = {},
) {
  const tracks = [];
  for (const { file, offset } of entries) {
    onProgress?.(`Decoding ${file.name}`);
    tracks.push({ ...(await decode(file)), offset: offset || 0 });
  }
  onProgress?.('Writing the mix');
  return mixTracks(tracks, { quality });
}
