import { describe, it, expect } from 'vitest';
import { mediaFingerprint } from './mediaFingerprint.js';

// A recording's identity for what was measured on it (speech-detection cuts).
// Byte length alone took one take for another: the hunter's realA.wav and
// realB.wav are both 1,920,044 bytes.

// A WAV-shaped file: one header, then samples made from `seed`.
const take = (seed, size = 1_920_044) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('RIFF....WAVEfmt '), 0);
  let x = seed;
  for (let i = 44; i < size; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
};

describe('mediaFingerprint', () => {
  it('tells apart two recordings of the same length', async () => {
    const a = await mediaFingerprint(new Blob([take(1)]));
    const b = await mediaFingerprint(new Blob([take(2)]));
    expect(a).not.toBe(b);
    expect(a.startsWith('1920044:')).toBe(true);
  });

  it('gives the same file the same print, however it arrived', async () => {
    const bytes = take(7);
    expect(await mediaFingerprint(new Blob([bytes]))).toBe(
      await mediaFingerprint(new Blob([bytes.slice()])),
    );
  });

  it('reads a small file whole', async () => {
    const one = new Uint8Array([1, 2, 3, 4]);
    const other = new Uint8Array([1, 2, 3, 5]);
    expect(await mediaFingerprint(new Blob([one]))).not.toBe(
      await mediaFingerprint(new Blob([other])),
    );
  });

  it('has no print without a recording', async () => {
    expect(await mediaFingerprint(null)).toBeNull();
  });
});
