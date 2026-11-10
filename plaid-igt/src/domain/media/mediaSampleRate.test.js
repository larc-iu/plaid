import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mp3Encoder } from '@breezystack/lamejs';
import { readSampleRate } from './mediaSampleRate.js';
import { encodeWav } from './wavFixture.js';

// Recordings made by Chromium's MediaRecorder at 48 kHz, each holding byte
// pairs in its compressed payload that look like an MPEG frame header.
const fixture = (name) =>
  new Uint8Array(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'rate-fixtures', name)),
  );

// A real MP3 of a tone, from the encoder the app uses.
const mp3Of = (rate) => {
  const encoder = new Mp3Encoder(1, rate, 64);
  const pcm = new Int16Array(rate / 2).map((_, i) => Math.round(8000 * Math.sin(i / 7)));
  const parts = [encoder.encodeBuffer(pcm), encoder.flush()];
  return cat(...parts.map((p) => new Uint8Array(p.buffer, p.byteOffset, p.length)));
};
// MPEG 1 Layer III, 128 kbit/s, 44.1 kHz, no padding: a 417-byte frame.
const FALSE_SYNC = [0xff, 0xfb, 0x90, 0x00];
const frameOf = (length) => {
  const out = new Uint8Array(length);
  out.set(FALSE_SYNC);
  return out;
};

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

  it('reads a real MP3, and past junk only where a second frame follows', async () => {
    expect(await readSampleRate(fileOf(mp3Of(22050)))).toBe(22050);
    expect(await readSampleRate(fileOf(mp3Of(48000)))).toBe(48000);
    const junk = new Uint8Array(300).fill(7);
    junk.set(FALSE_SYNC, 100); // a lone header-like pair in the junk
    expect(await readSampleRate(fileOf(cat(junk, mp3Of(16000))))).toBe(16000);
    expect(await readSampleRate(fileOf(junk))).toBe(null);
  });

  it('reads an M4A and an MP4 video by their sound track, not a false MP3 sync', async () => {
    expect(await readSampleRate(fileOf(fixture('opus.m4a')))).toBe(48000);
    expect(await readSampleRate(fileOf(fixture('video.mp4')))).toBe(48000);
  });

  it('reads an MP4 whose payload holds two MP3-like frames before its moov', async () => {
    const mdat = box('mdat', cat(frameOf(417), frameOf(417)));
    const audio = box(
      'trak',
      box('mdia', cat(box('hdlr', withHandler('soun')), box('mdhd', timescale(48000)))),
    );
    const file = cat(box('ftyp', new Uint8Array(8)), mdat, box('moov', audio));
    expect(await readSampleRate(fileOf(file))).toBe(48000);
  });

  // `fLaC`, a STREAMINFO block (the last, 34 bytes) whose bits 80 to 99 are
  // the rate, then a payload of two MP3-like frames in a row.
  const flacOf = (rate, { first = 0x80 } = {}) => {
    const info = new Uint8Array(34);
    info[10] = rate >> 12;
    info[11] = (rate >> 4) & 0xff;
    info[12] = ((rate & 0x0f) << 4) | (1 << 1); // stereo, then 16 bits a sample
    info[13] = 0xf0;
    return cat(
      new Uint8Array([0x66, 0x4c, 0x61, 0x43, first, 0, 0, 34]),
      info,
      frameOf(417),
      frameOf(417),
    );
  };

  it('reads a FLAC from its STREAMINFO block', async () => {
    expect(await readSampleRate(fileOf(flacOf(16000)))).toBe(16000);
    expect(await readSampleRate(fileOf(flacOf(96000)))).toBe(96000);
    expect(await readSampleRate(fileOf(flacOf(44100, { first: 0x00 })))).toBe(44100);
  });

  it('says nothing for a FLAC whose first block is not STREAMINFO, or is cut short', async () => {
    expect(await readSampleRate(fileOf(flacOf(16000, { first: 0x84 })))).toBe(null);
    expect(await readSampleRate(fileOf(flacOf(16000).slice(0, 20)))).toBe(null);
  });

  it('says nothing for a WebM or an Ogg, whatever their payload holds', async () => {
    expect(await readSampleRate(fileOf(fixture('opus.webm')))).toBe(null);
    // An Ogg page header, then a payload of two MP3-like frames in a row.
    const ogg = cat(
      new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, ...new Array(22).fill(0)]),
      frameOf(417),
      frameOf(417),
    );
    expect(await readSampleRate(fileOf(ogg))).toBe(null);
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
