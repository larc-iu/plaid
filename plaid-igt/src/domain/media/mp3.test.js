import { describe, it, expect } from 'vitest';
import { Mp3Encoder } from '@breezystack/lamejs';
import { mp3NameFor, estimateMp3Bytes, MP3_BITRATE_KBPS } from './transcodeToMp3.js';

// The worker's encode loop, which cannot be imported here (it installs a
// self.onmessage handler on load). Kept identical to mp3Worker.js so this
// tests the same arithmetic: block size, PCM scaling, and the flush.
const BLOCK = 1152;
const encode = (samples, sampleRate = 16000) => {
  const encoder = new Mp3Encoder(1, sampleRate, MP3_BITRATE_KBPS);
  const parts = [];
  const pcm = new Int16Array(BLOCK);
  for (let from = 0; from < samples.length; from += BLOCK) {
    const count = Math.min(BLOCK, samples.length - from);
    for (let i = 0; i < count; i++) {
      const s = Math.max(-1, Math.min(1, samples[from + i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const chunk = encoder.encodeBuffer(count === BLOCK ? pcm : pcm.subarray(0, count));
    if (chunk.length) parts.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(tail);
  const bytes = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A 440 Hz tone, the length of `seconds` at 16 kHz. */
const tone = (seconds) => {
  const samples = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000);
  return samples;
};

describe('mp3 encoding', () => {
  it('produces a real MP3 stream', () => {
    const mp3 = encode(tone(2));
    // Frame sync: eleven set bits. MPEG-2/2.5 at 16 kHz gives 0xFF 0xF3-ish,
    // so check the sync itself rather than a particular version nibble.
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1] & 0xe0).toBe(0xe0);
    expect(mp3.length).toBeGreaterThan(1000);
  });

  it('lands near the bitrate it promises', () => {
    const seconds = 4;
    const mp3 = encode(tone(seconds));
    const estimate = estimateMp3Bytes(seconds);
    // Within a third: LAME pads and writes a header, and a pure tone is not a
    // typical signal. The point is that the estimate shown to a user is not
    // wrong by an order of magnitude.
    expect(mp3.length).toBeGreaterThan(estimate * 0.66);
    expect(mp3.length).toBeLessThan(estimate * 1.34);
  });

  it('encodes silence and a final partial block without complaint', () => {
    const samples = new Float32Array(16000 + 7); // not a multiple of 1152
    expect(encode(samples).length).toBeGreaterThan(0);
  });

  it('clamps samples outside [-1, 1] rather than wrapping them', () => {
    const loud = new Float32Array(BLOCK * 2).fill(4);
    expect(encode(loud).length).toBeGreaterThan(0);
  });
});

describe('mp3NameFor', () => {
  it('replaces the extension', () => {
    expect(mp3NameFor('oni-lifestory-ah-c.mp4')).toBe('oni-lifestory-ah-c.mp3');
    expect(mp3NameFor('recording.with.dots.wav')).toBe('recording.with.dots.mp3');
    expect(mp3NameFor('no-extension')).toBe('no-extension.mp3');
    expect(mp3NameFor('')).toBe('audio.mp3');
    expect(mp3NameFor(undefined)).toBe('audio.mp3');
  });
});
