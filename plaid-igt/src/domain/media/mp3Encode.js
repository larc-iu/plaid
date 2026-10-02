// The MP3 encode itself, apart from the worker that runs it (mp3Worker.js), so
// a test runs the same code.

import { Mp3Encoder } from '@breezystack/lamejs';

// LAME's frame size. Anything else just gets buffered into these internally.
const BLOCK = 1152;
const PROGRESS_EVERY = 200; // blocks, ~14 s of audio at 16 kHz

/**
 * How many samples late LAME's output plays: its own look-ahead (576) plus
 * the MP3 synthesis filter's (529). A decoder trims them only when the file
 * carries a LAME tag that says so, and lamejs writes none, so every decoder
 * plays them. Measured in Chrome at 16 kHz: an impulse comes back 1105
 * samples late, 69.06 ms.
 */
export const ENCODER_DELAY = 1105;

/** Float samples in [-1, 1] to 16-bit PCM, which is what the encoder takes. */
const toPcm = (samples, from, count, into) => {
  for (let i = 0; i < count; i++) {
    const s = Math.max(-1, Math.min(1, samples[from + i]));
    into[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return count === into.length ? into : into.subarray(0, count);
};

/**
 * Mono `samples` at `sampleRate` to MP3 bytes, timed exactly as the samples:
 * a sound at time t in them plays at time t in the MP3. The encoder delay is
 * taken off the front of what it is fed, so the first 69 ms play as silence
 * and everything after them plays on the original's clock.
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} bitrateKbps
 * @param {(done: number, total: number) => void} [onProgress]  in blocks
 * @returns {Uint8Array}
 */
export function encodeMp3(samples, sampleRate, bitrateKbps, onProgress) {
  const encoder = new Mp3Encoder(1, sampleRate, bitrateKbps);
  const parts = [];
  const pcm = new Int16Array(BLOCK);
  let bytes = 0;
  const fed = samples.subarray(Math.min(ENCODER_DELAY, samples.length));
  const blocks = Math.ceil(fed.length / BLOCK);

  for (let b = 0; b < blocks; b++) {
    const from = b * BLOCK;
    const chunk = encoder.encodeBuffer(toPcm(fed, from, Math.min(BLOCK, fed.length - from), pcm));
    if (chunk.length) {
      parts.push(chunk);
      bytes += chunk.length;
    }
    if (b % PROGRESS_EVERY === 0) onProgress?.(b, blocks);
  }

  const tail = encoder.flush();
  if (tail.length) {
    parts.push(tail);
    bytes += tail.length;
  }

  const out = new Uint8Array(bytes);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
