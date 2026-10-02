// A recording's identity, read from its own bytes: its length and a hash over
// evenly spaced samples of it (the whole file when it is small). Two takes of
// one length differ in their samples, so neither is taken for the other. The
// same file uploaded again, copied, or carried in an archive gets the same
// print, which a stamp of when it was uploaded would not. Reading a few dozen
// kilobytes of a file already in memory costs nothing next to playing it.

const SAMPLES = 32;
const SAMPLE_BYTES = 4096;

// Two independent 32-bit FNV-1a style lanes, so a print is 64 bits wide.
const hashInto = (state, bytes) => {
  let [a, b] = state;
  for (let i = 0; i < bytes.length; i += 1) {
    a = Math.imul(a ^ bytes[i], 16777619);
    b = Math.imul(b ^ bytes[i], 2246822519);
  }
  return [a >>> 0, b >>> 0];
};

const hex = (n) => n.toString(16).padStart(8, '0');

/**
 * `<byte length>:<16 hex digits>` for `blob`, or null without one.
 * @param {Blob|null} blob
 * @returns {Promise<string|null>}
 */
export async function mediaFingerprint(blob) {
  if (!blob) return null;
  const size = blob.size;
  const starts = [];
  if (size <= SAMPLES * SAMPLE_BYTES) {
    starts.push(0);
  } else {
    // The first and the last sample, and the rest spread evenly between.
    const step = (size - SAMPLE_BYTES) / (SAMPLES - 1);
    for (let i = 0; i < SAMPLES; i += 1) starts.push(Math.floor(i * step));
  }
  let state = [2166136261, 3735928559];
  for (const start of starts) {
    const end = size <= SAMPLES * SAMPLE_BYTES ? size : start + SAMPLE_BYTES;
    const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    state = hashInto(state, bytes);
  }
  return `${size}:${hex(state[0])}${hex(state[1])}`;
}
