// One decode of a recording for everything that wants it at the same time:
// the timeline's waveform and speech detection both take 16 kHz samples
// (decodeTo16k), and an hour of them is 230 MB. A second caller while a
// decode is running joins it rather than starting another. Nothing is kept
// once it lands: the waveform keeps only its envelope, and detection hands
// its samples to a worker.
import { decodeTo16k } from './decodeTo16kMono.js';

const running = new Map();

/**
 * @param {Blob} blob
 * @param {{perChannel?: boolean}} [options]  keep the channels apart as well
 *   as the mix of them (a recording with a speaker on each channel)
 * @returns {Promise<{samples: Float32Array, channels: Float32Array[]|null,
 *   channelCount: number, shared: boolean}>} `shared` when another caller got
 *   the same arrays, which a caller that transfers or changes them must then
 *   copy first.
 */
export function decodeShared(blob, { perChannel = false } = {}) {
  // A decode keeping the channels apart serves a caller wanting only the mix,
  // and not the other way round, so a caller asking for the channels while a
  // mono decode runs starts its own.
  let entry = running.get(blob);
  if (!entry || (perChannel && !entry.perChannel)) {
    entry = { takers: 0, perChannel };
    entry.promise = decodeTo16k(blob, { perChannel }).finally(() => {
      if (running.get(blob) === entry) running.delete(blob);
    });
    running.set(blob, entry);
  }
  entry.takers += 1;
  return entry.promise.then(({ mono, channels, channelCount }) => ({
    samples: mono,
    channels,
    channelCount,
    shared: entry.takers > 1,
  }));
}
