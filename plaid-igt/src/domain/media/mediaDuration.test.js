import { describe, it, expect } from 'vitest';
import { __test } from './mediaDuration.js';

// A file made only of box headers: `mdat` is declared huge but nothing is
// there, which is the point — the walk must skip it by its declared size
// rather than read it. `moov` sits AFTER it, the way ffmpeg writes one.
const box = (type, bodyBytes = new Uint8Array(0)) => {
  const out = new Uint8Array(8 + bodyBytes.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(bodyBytes, 8);
  return out;
};

const mvhdV0 = (timescale, duration) => {
  const body = new Uint8Array(100);
  const view = new DataView(body.buffer);
  view.setUint8(0, 0); // version 0
  view.setUint32(12, timescale);
  view.setUint32(16, duration);
  return box('mvhd', body);
};

const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A Blob-alike with the slice/arrayBuffer/size a walk needs. */
const fileOf = (bytes) => new Blob([bytes]);

describe('mp4Duration', () => {
  it('reads the duration from an mvhd after a large mdat', async () => {
    const mdat = box('mdat');
    // Declare mdat far larger than its bytes: the walk must jump, not read.
    new DataView(mdat.buffer).setUint32(0, 8);
    const file = fileOf(concat(box('ftyp'), mdat, box('moov', mvhdV0(1000, 2_319_543))));
    expect(await __test.mp4Duration(file)).toBeCloseTo(2319.543, 3);
  });

  it('reads a timescale other than milliseconds', async () => {
    const file = fileOf(concat(box('ftyp'), box('moov', mvhdV0(600, 3600))));
    expect(await __test.mp4Duration(file)).toBe(6);
  });

  it('is null for a file with no moov', async () => {
    expect(await __test.mp4Duration(fileOf(concat(box('ftyp'), box('mdat'))))).toBeNull();
  });

  it('is null for a moov with no mvhd', async () => {
    expect(await __test.mp4Duration(fileOf(concat(box('moov', box('trak')))))).toBeNull();
  });

  it('is null rather than looping on a zero-length box', async () => {
    const broken = box('ftyp');
    new DataView(broken.buffer).setUint32(0, 4); // smaller than a header
    expect(await __test.mp4Duration(fileOf(broken))).toBeNull();
  });

  it('is null for something that is not an mp4 at all', async () => {
    expect(await __test.mp4Duration(fileOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))).toBeNull();
  });
});
