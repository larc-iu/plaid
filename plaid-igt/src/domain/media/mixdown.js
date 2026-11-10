// Several recordings as one: the arithmetic of a mix, with no Web Audio in it
// so it runs in node. One input file is one channel of the mix (a stereo
// input is averaged to mono first), every channel runs the same clock, and a
// file's offset is leading silence (a negative one trims its start). The
// result is 16-bit PCM WAV, WAVE_FORMAT_EXTENSIBLE past two channels with no
// channel mask, which every browser and ffmpeg read. Each input is written
// straight into the WAV's bytes, so a mix holds the file it makes and one
// decoded input at a time. mixRecordings.js does the decoding and calls into
// here.

/** The rate of the "Smaller" mix: mono speech needs no more. */
export const SMALL_RATE = 16000;

/** The rate taken for a file whose header does not say (a WebM, say). */
export const FALLBACK_RATE = 48000;

const PCM_HEADER_BYTES = 44;
const EXTENSIBLE_HEADER_BYTES = 68;
const WAV_PCM = 0x0001;
const WAV_EXTENSIBLE = 0xfffe;

/** `[{seconds, sampleRate, offset}]` in, the mix's length in seconds. */
export function mixSeconds(tracks) {
  let longest = 0;
  for (const t of tracks || []) {
    const seconds = Number(t.seconds) || 0;
    const offset = Number(t.offset) || 0;
    longest = Math.max(longest, seconds + offset);
  }
  return longest;
}

/** The mix's sample rate for a quality: `small` is 16 kHz, `full` the highest input rate. */
export function mixRate(tracks, quality) {
  if (quality === 'small') return SMALL_RATE;
  let rate = 0;
  for (const t of tracks || []) rate = Math.max(rate, Number(t.sampleRate) || 0);
  return rate || FALLBACK_RATE;
}

export const wavHeaderBytes = (channels) =>
  channels > 2 ? EXTENSIBLE_HEADER_BYTES : PCM_HEADER_BYTES;

const wavBytes = (channels, frames) =>
  channels ? wavHeaderBytes(channels) + frames * channels * 2 : 0;

/** How many bytes the mix comes to, before it is made. */
export function mixBytes(tracks, quality) {
  const channels = (tracks || []).length;
  return wavBytes(channels, Math.ceil(mixSeconds(tracks) * mixRate(tracks, quality)));
}

/**
 * How many bytes one file (`{channels, seconds, sampleRate}`) comes to as a
 * WAV at a quality, with every channel kept as it is.
 */
export function keptChannelsBytes({ channels, seconds, sampleRate }, quality) {
  const rate = mixRate([{ sampleRate }], quality);
  return wavBytes(channels, Math.ceil((Number(seconds) || 0) * rate));
}

const stem = (name) => String(name || '').replace(/\.[^./\\]*$/, '') || 'recording';

/** The mix's file name: the first file's, said to be mixed. */
export function mixName(firstName, count) {
  return `${stem(firstName)} (mixed, ${count} speakers).wav`;
}

/** A file's name once it is a WAV: "talk.mp3" is "talk.wav". */
export const wavName = (name) => `${stem(name)}.wav`;

const clamp16 = (v) => {
  const n = Math.round(v * 32767);
  return n > 32767 ? 32767 : n < -32768 ? -32768 : n;
};

/**
 * A silent 16-bit PCM WAV of `channels` channels and `frames` frames,
 * WAVE_FORMAT_EXTENSIBLE with channel mask 0 past two. `writeChannel` fills it.
 */
export function emptyWav(channels, frames, sampleRate) {
  const header = wavHeaderBytes(channels);
  const dataSize = frames * channels * 2;
  const bytes = new Uint8Array(header + dataSize);
  const view = new DataView(bytes.buffer);
  const tag = (at, s) => {
    for (let i = 0; i < 4; i += 1) bytes[at + i] = s.charCodeAt(i);
  };
  const blockAlign = channels * 2;
  tag(0, 'RIFF');
  view.setUint32(4, header - 8 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  if (channels > 2) {
    view.setUint32(16, 40, true);
    view.setUint16(20, WAV_EXTENSIBLE, true);
  } else {
    view.setUint32(16, 16, true);
    view.setUint16(20, WAV_PCM, true);
  }
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  let at = 36;
  if (channels > 2) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, 16, true); // valid bits per sample
    view.setUint32(40, 0, true); // channel mask: no speaker positions
    // The PCM subformat GUID, 00000001-0000-0010-8000-00AA00389B71.
    view.setUint16(44, WAV_PCM, true);
    view.setUint16(46, 0, true);
    view.setUint16(48, 0, true);
    view.setUint16(50, 0x0010, true);
    bytes.set([0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 52);
    at = 60;
  }
  tag(at, 'data');
  view.setUint32(at + 4, dataSize, true);
  return bytes;
}

/**
 * One input written into channel `channel` of a WAV from `emptyWav`: its
 * channels (`sources`, one Float32Array each, at the WAV's rate) averaged to
 * one, with `offset` seconds of silence before it or its first `-offset`
 * seconds cut, and nothing past the WAV's end.
 */
export function writeChannel(bytes, channel, sources, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const header = wavHeaderBytes(count);
  const frames = (bytes.byteLength - header) / (count * 2);
  const shift = Math.round((Number(offset) || 0) * sampleRate);
  const from = Math.max(0, -shift);
  const to = Math.max(0, shift);
  const length = Math.max(0, ...sources.map((s) => s.length));
  const n = Math.max(0, Math.min(length - from, frames - to));
  const one = sources.length === 1 ? sources[0] : null;
  let pos = header + (to * count + channel) * 2;
  for (let i = from; i < from + n; i += 1) {
    let v;
    if (one) v = one[i];
    else {
      v = 0;
      for (let k = 0; k < sources.length; k += 1) if (i < sources[k].length) v += sources[k][i];
      v /= sources.length;
    }
    view.setInt16(pos, clamp16(v), true);
    pos += count * 2;
  }
}

/**
 * How a decoded input is said on screen: its channels and what becomes of
 * them, and its rate.
 */
export function trackNote({ channels, sampleRate }) {
  const rate = `${Math.round(sampleRate / 100) / 10} kHz`;
  if (channels === 1) return `mono · ${rate}`;
  const what = channels === 2 ? 'stereo' : `${channels} channels`;
  return `${what}, mixed to one channel · ${rate}`;
}
