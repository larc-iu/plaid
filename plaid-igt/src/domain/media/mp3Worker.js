// MP3 encoding, off the main thread.
//
// LAME in plain JavaScript (~60 kB gzipped, no wasm and so no cross-origin
// isolation to arrange), fed the mono 16 kHz samples the decoder already
// produces for speech detection. An hour of audio takes tens of seconds of
// solid CPU, which is exactly the kind of work that must not run on the thread
// painting the page.

import { Mp3Encoder } from '@breezystack/lamejs';

// LAME's frame size. Anything else just gets buffered into these internally.
const BLOCK = 1152;
const PROGRESS_EVERY = 200; // blocks, ~14 s of audio at 16 kHz

let cancelled = false;

/** Float samples in [-1, 1] to 16-bit PCM, which is what the encoder takes. */
const toPcm = (samples, from, count, into) => {
  for (let i = 0; i < count; i++) {
    const s = Math.max(-1, Math.min(1, samples[from + i]));
    into[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return count === into.length ? into : into.subarray(0, count);
};

function encode(samples, sampleRate, bitrateKbps) {
  const encoder = new Mp3Encoder(1, sampleRate, bitrateKbps);
  const parts = [];
  const pcm = new Int16Array(BLOCK);
  let bytes = 0;
  const blocks = Math.ceil(samples.length / BLOCK);

  for (let b = 0; b < blocks; b++) {
    if (cancelled) return null;
    const from = b * BLOCK;
    const chunk = encoder.encodeBuffer(
      toPcm(samples, from, Math.min(BLOCK, samples.length - from), pcm),
    );
    if (chunk.length) {
      parts.push(chunk);
      bytes += chunk.length;
    }
    if (b % PROGRESS_EVERY === 0) self.postMessage({ type: 'progress', done: b, total: blocks });
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

self.onmessage = ({ data }) => {
  if (data.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (data.type !== 'run') return;
  cancelled = false;
  try {
    const mp3 = encode(data.samples, data.sampleRate, data.bitrateKbps);
    if (mp3) self.postMessage({ type: 'result', mp3 }, [mp3.buffer]);
    else self.postMessage({ type: 'cancelled' });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message ?? String(error) });
  }
};
