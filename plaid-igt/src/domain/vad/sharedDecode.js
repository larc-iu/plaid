// One decode of a recording for everything that wants it at the same time:
// the timeline's waveform and speech detection both take mono 16 kHz samples
// (decodeTo16kMono), and an hour of them is 230 MB. A second caller while a
// decode is running joins it rather than starting another. Nothing is kept
// once it lands: the waveform keeps only its envelope, and detection hands
// its samples to a worker.
import { decodeTo16kMono } from './decodeTo16kMono.js';

const running = new Map();

/**
 * @param {Blob} blob
 * @returns {Promise<{samples: Float32Array, shared: boolean}>} `shared` when
 *   another caller got the same array, which a caller that transfers or
 *   changes it must then copy first.
 */
export function decodeShared(blob) {
  let entry = running.get(blob);
  if (!entry) {
    entry = { takers: 0 };
    entry.promise = decodeTo16kMono(blob).finally(() => {
      if (running.get(blob) === entry) running.delete(blob);
    });
    running.set(blob, entry);
  }
  entry.takers += 1;
  return entry.promise.then((samples) => ({ samples, shared: entry.takers > 1 }));
}
