// A recording's own sample rate, read from its header. The browser's decoder
// resamples to whatever rate it is asked for and never says what the file
// had, so "full quality" (the highest rate among the files being mixed) is
// read here: a WAV says so in its `fmt ` chunk, an MP3 in every frame header,
// an MP4 or M4A in the sound track's `mdhd` box. Anything else (a WebM, an
// Ogg) is unknown, and the caller takes a fixed rate for it.

import { readWavInfo } from './wavAdpcm.js';

const readSlice = async (file, from, to) =>
  new DataView(await file.slice(from, Math.min(to, file.size)).arrayBuffer());

const typeAt = (view, at) =>
  String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );

const fileReader = (file) => async (from, to) =>
  new Uint8Array(await file.slice(from, Math.min(to, file.size)).arrayBuffer());

async function wavRate(file) {
  const info = await readWavInfo(fileReader(file), file.size).catch(() => null);
  return info?.sampleRate || null;
}

// MPEG audio frame header: the rate index per version.
const MP3_RATES = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};
const MP3_SCAN_BYTES = 64 * 1024;

async function mp3Rate(file) {
  const head = await readSlice(file, 0, 10);
  if (head.byteLength < 10) return null;
  let at = 0;
  // Past an ID3v2 tag, whose size is four 7-bit bytes.
  if (typeAt(head, 0).startsWith('ID3')) {
    at =
      10 +
      ((head.getUint8(6) << 21) |
        (head.getUint8(7) << 14) |
        (head.getUint8(8) << 7) |
        head.getUint8(9));
  }
  const view = await readSlice(file, at, at + MP3_SCAN_BYTES);
  for (let i = 0; i + 3 < view.byteLength; i += 1) {
    if (view.getUint8(i) !== 0xff || (view.getUint8(i + 1) & 0xe0) !== 0xe0) continue;
    const version = (view.getUint8(i + 1) >> 3) & 0x03;
    const layer = (view.getUint8(i + 1) >> 1) & 0x03;
    const rateIndex = (view.getUint8(i + 2) >> 2) & 0x03;
    if (version === 1 || layer === 0 || rateIndex === 3) continue;
    return MP3_RATES[version][rateIndex];
  }
  return null;
}

// The box chain of an MP4: `moov` > `trak` (the one whose `hdlr` is `soun`)
// > `mdia` > `mdhd`, whose timescale is the sound's sample rate.
async function mp4Rate(file) {
  const children = async (from, end) => {
    const out = [];
    let at = from;
    while (at + 8 <= end) {
      const head = await readSlice(file, at, at + 16);
      if (head.byteLength < 8) break;
      let size = head.getUint32(0);
      let body = at + 8;
      if (size === 1) {
        if (head.byteLength < 16) break;
        size = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
        body = at + 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < 8) break;
      out.push({ type: typeAt(head, 4), body, end: at + size });
      at += size;
    }
    return out;
  };
  const find = (boxes, type) => boxes.find((b) => b.type === type) ?? null;
  const top = await children(0, file.size);
  if (!find(top, 'ftyp') && !find(top, 'moov')) return null;
  const moov = find(top, 'moov');
  if (!moov) return null;
  for (const trak of (await children(moov.body, moov.end)).filter((b) => b.type === 'trak')) {
    const mdia = find(await children(trak.body, trak.end), 'mdia');
    if (!mdia) continue;
    const inMdia = await children(mdia.body, mdia.end);
    const hdlr = find(inMdia, 'hdlr');
    const mdhd = find(inMdia, 'mdhd');
    if (!hdlr || !mdhd) continue;
    const handler = await readSlice(file, hdlr.body + 8, hdlr.body + 12);
    if (handler.byteLength < 4 || typeAt(handler, 0) !== 'soun') continue;
    const box = await readSlice(file, mdhd.body, mdhd.body + 24);
    if (box.byteLength < 20) continue;
    const version = box.getUint8(0);
    const timescale = version === 1 ? box.getUint32(20) : box.getUint32(12);
    if (timescale > 0) return timescale;
  }
  return null;
}

/** The file's sample rate in Hz, or null when its header does not say. */
export async function readSampleRate(file) {
  for (const read of [wavRate, mp3Rate, mp4Rate]) {
    try {
      const rate = await read(file);
      if (rate) return rate;
    } catch {
      // A truncated or unusual file: the next reader has its turn.
    }
  }
  return null;
}
