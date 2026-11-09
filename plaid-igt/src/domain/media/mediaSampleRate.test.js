import { describe, it, expect } from 'vitest';
import { readSampleRate } from './mediaSampleRate.js';
import { encodeWav } from './mixdown.js';

// A File stands in by its bytes: `slice` and `size` are all the readers use.
const fileOf = (bytes) => ({
  size: bytes.length,
  slice: (from, to) => ({ arrayBuffer: async () => bytes.slice(from, to).buffer }),
});

const box = (type, body) => {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
};
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('readSampleRate', () => {
  it('reads a WAV from its fmt chunk', async () => {
    const wav = encodeWav([Float32Array.from([0, 0])], 22050);
    expect(await readSampleRate(fileOf(wav))).toBe(22050);
  });

  it('reads an MP3 from its first frame header, past an ID3 tag', async () => {
    // ID3v2 tag of 10 bytes of body, then an MPEG 1 Layer III frame at 44.1 kHz.
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]);
    const frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]);
    expect(await readSampleRate(fileOf(cat(id3, frame)))).toBe(44100);
    // MPEG 2 Layer III at 16 kHz.
    const mpeg2 = new Uint8Array([0xff, 0xf3, 0x88, 0x00]);
    expect(await readSampleRate(fileOf(mpeg2))).toBe(16000);
  });

  it('reads an MP4 from its sound track', async () => {
    const mdhd = new Uint8Array(24);
    new DataView(mdhd.buffer).setUint32(12, 48000); // version 0 timescale
    const hdlr = new Uint8Array(24);
    hdlr.set([0x73, 0x6f, 0x75, 0x6e], 8); // 'soun'
    const video = box(
      'trak',
      box('mdia', cat(box('hdlr', withHandler('vide')), box('mdhd', timescale(600)))),
    );
    const audio = box('trak', box('mdia', cat(box('hdlr', hdlr), box('mdhd', mdhd))));
    const file = cat(box('ftyp', new Uint8Array(8)), box('moov', cat(video, audio)));
    expect(await readSampleRate(fileOf(file))).toBe(48000);
  });

  it('says nothing for a file whose header does not say', async () => {
    expect(
      await readSampleRate(fileOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))),
    ).toBe(null);
    expect(await readSampleRate(fileOf(new Uint8Array(0)))).toBe(null);
  });
});

const withHandler = (type) => {
  const out = new Uint8Array(24);
  for (let i = 0; i < 4; i += 1) out[8 + i] = type.charCodeAt(i);
  return out;
};
const timescale = (n) => {
  const out = new Uint8Array(24);
  new DataView(out.buffer).setUint32(12, n);
  return out;
};
