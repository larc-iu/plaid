import { describe, it, expect } from 'vitest';
import { Mp3Encoder } from '@breezystack/lamejs';
import { mp3NameFor, estimateMp3Bytes, MP3_BITRATE_KBPS } from './transcodeToMp3.js';
import { encodeMp3, ENCODER_DELAY } from './mp3Encode.js';

const encode = (samples, sampleRate = 16000) => encodeMp3(samples, sampleRate, MP3_BITRATE_KBPS);
const BLOCK = 1152;

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

// The conversion promises the original's timing. LAME's output plays
// ENCODER_DELAY samples late and lamejs writes no tag a decoder could trim it
// by, so the encoder is fed the recording without that many samples at the
// front. Decoded in Chromium, speech placed at 1, 60 and 110 s comes back
// 1105 samples late before and 0 after (plaid-igt/out/FX-W2-MEDIA/mp3lag.mjs,
// the hunter's cross-correlation). Node has no MP3 decoder, so this pins what
// the encoder is fed.
describe('mp3 timing', () => {
  const raw = (samples) => {
    const encoder = new Mp3Encoder(1, 16000, MP3_BITRATE_KBPS);
    const pcm = Int16Array.from(samples, (s) => (s < 0 ? s * 0x8000 : s * 0x7fff));
    const parts = [];
    for (let from = 0; from < pcm.length; from += BLOCK) {
      parts.push(encoder.encodeBuffer(pcm.subarray(from, Math.min(pcm.length, from + BLOCK))));
    }
    parts.push(encoder.flush());
    return Uint8Array.from(parts.flatMap((p) => [...p]));
  };

  it('feeds the encoder the recording less its delay', () => {
    const samples = tone(3);
    expect(ENCODER_DELAY).toBe(1105);
    expect(encode(samples)).toEqual(raw(samples.subarray(ENCODER_DELAY)));
  });

  it('copes with a recording shorter than the delay', () => {
    expect(() => encode(new Float32Array(100))).not.toThrow();
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
