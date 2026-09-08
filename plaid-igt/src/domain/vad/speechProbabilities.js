// Main-thread side of the detector: decode, hand the samples to the worker,
// report progress, give back the per-frame probabilities.
//
// The probabilities are the expensive part and they do NOT depend on any of
// the parameters the user tunes. So the Media tab runs this once per recording
// and keeps the result. Moving the threshold or a duration re-runs only
// speechTimestamps.js, which is instant. That is the whole reason this
// returns probabilities rather than segments.

import { decodeTo16kMono } from './decodeTo16kMono.js';

/**
 * @param {Blob} blob                 the recording, as fetched for playback
 * @param {(fraction: number) => void} [onProgress]  0..1, model frames only
 * @returns {Promise<{probs: Float32Array, lengthSamples: number} | null>}
 *          null when cancelled
 */
export async function speechProbabilities(blob, { onProgress, signal } = {}) {
  const samples = await decodeTo16kMono(blob);
  const lengthSamples = samples.length;
  if (signal?.aborted) return null;

  const worker = new Worker(new URL('./vadWorker.js', import.meta.url), { type: 'module' });

  try {
    const probs = await new Promise((resolve, reject) => {
      const abort = () => worker.postMessage({ type: 'cancel' });
      signal?.addEventListener('abort', abort, { once: true });

      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress?.(data.total ? data.done / data.total : 0);
        else if (data.type === 'result') resolve(data.probs);
        else if (data.type === 'cancelled') resolve(null);
        else if (data.type === 'error') reject(new Error(data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || 'Speech detection failed.'));

      // Transferred, not copied: an hour of audio is not worth duplicating.
      worker.postMessage({ type: 'run', samples }, [samples.buffer]);
    });

    return probs ? { probs, lengthSamples } : null;
  } finally {
    worker.terminate();
  }
}
