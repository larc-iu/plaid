// A recording's own sample rate, read from its header. The browser's decoder
// resamples to whatever rate it is asked for and never says what the file
// had, so "full quality" (the highest rate among the files being mixed) is
// read here: a WAV says so in its `fmt ` chunk, a FLAC in its STREAMINFO
// block, an MP4 or M4A in the sound track's `mdhd` box, an MP3 in every frame
// header. The containers are read
// first, since their compressed payload holds byte pairs that look like an
// MP3 frame header. Anything else (a WebM, an Ogg) is unknown, and the caller
// takes a fixed rate for it.

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

// A FLAC starts `fLaC`, then the STREAMINFO block: a 4-byte block header
// (type 0) and 34 bytes, whose 20 bits from byte 10 are the rate.
async function flacRate(file) {
  const view = await readSlice(file, 0, 21);
  if (view.byteLength < 21 || typeAt(view, 0) !== 'fLaC') return null;
  if ((view.getUint8(4) & 0x7f) !== 0) return null;
  return (view.getUint8(18) << 12) | (view.getUint8(19) << 4) | (view.getUint8(20) >> 4);
}

// MPEG audio frame header: the rate index per version, and the bitrate index
// in kbit/s per version and layer (version 3 is MPEG 1, 2 is MPEG 2, 0 is
// MPEG 2.5, layer 3 is Layer I, 2 Layer II, 1 Layer III).
const MP3_RATES = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};
const MP3_KBPS = {
  '3:3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3:2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3:1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2:3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2:2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SCAN_BYTES = 64 * 1024;
// Past the scan, room for the longest frame (Layer II at 160 kbit/s, 8 kHz).
const MP3_FRAME_ROOM = 4096;

// The frame header at `i`: its version, layer, rate and length in bytes (null
// for a free-format frame), or null when the bytes are not a frame header.
function mp3Frame(view, i) {
  if (i + 4 > view.byteLength) return null;
  const b1 = view.getUint8(i + 1);
  const b2 = view.getUint8(i + 2);
  if (view.getUint8(i) !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 0x03;
  if (version === 1 || layer === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const rate = MP3_RATES[version][rateIndex];
  const kbps = MP3_KBPS[`${version === 3 ? 3 : 2}:${version === 3 || layer === 3 ? layer : 2}`];
  const bitrate = kbps[bitrateIndex] * 1000;
  const padding = (b2 >> 1) & 0x01;
  let length = null;
  if (bitrate && layer === 3) length = (Math.floor((12 * bitrate) / rate) + padding) * 4;
  else if (bitrate) {
    const perFrame = layer === 1 && version !== 3 ? 72 : 144;
    length = Math.floor((perFrame * bitrate) / rate) + padding;
  }
  return { version, layer, rate, length };
}

// The first bytes of containers that are not MPEG audio, so a frame-like pair
// in their payload is never read as one: Ogg, WebM or Matroska, a FLAC its
// reader could not read, a RIFF or AIFF that is not a readable WAV.
const NOT_MP3 = ['OggS', '\x1aE\xdf\xa3', 'fLaC', 'RIFF', 'FORM'];

async function mp3Rate(file) {
  const head = await readSlice(file, 0, 10);
  if (head.byteLength >= 4 && NOT_MP3.includes(typeAt(head, 0))) return null;
  let at = 0;
  // Past an ID3v2 tag, whose size is four 7-bit bytes.
  if (head.byteLength >= 10 && typeAt(head, 0).startsWith('ID3')) {
    at =
      10 +
      ((head.getUint8(6) << 21) |
        (head.getUint8(7) << 14) |
        (head.getUint8(8) << 7) |
        head.getUint8(9));
  }
  const view = await readSlice(file, at, at + MP3_SCAN_BYTES + MP3_FRAME_ROOM);
  // A frame where the audio starts is taken as it is.
  const first = mp3Frame(view, 0);
  if (first) return first.rate;
  // Past junk, a frame counts only when the next one follows at its length,
  // of the same version, layer and rate.
  for (let i = 1; i < MP3_SCAN_BYTES && i + 4 <= view.byteLength; i += 1) {
    const frame = mp3Frame(view, i);
    if (!frame?.length) continue;
    const next = mp3Frame(view, i + frame.length);
    if (
      next &&
      next.version === frame.version &&
      next.layer === frame.layer &&
      next.rate === frame.rate
    ) {
      return frame.rate;
    }
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
  for (const read of [wavRate, flacRate, mp4Rate, mp3Rate]) {
    try {
      const rate = await read(file);
      if (rate) return rate;
    } catch {
      // A truncated or unusual file: the next reader has its turn.
    }
  }
  return null;
}
