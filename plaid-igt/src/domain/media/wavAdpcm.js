// Reading a WAV's coding, and turning an ADPCM one into 16-bit PCM.
//
// Browsers play a WAV only when its samples are PCM or float. An ADPCM one
// (IMA, as ELAN and many field recorders write, or Microsoft's) is accepted
// by the server's content check like any other WAV and then never plays: the
// media element fails without a word. The recording is therefore decoded
// here, before it is uploaded, into a PCM WAV of the same rate and channels,
// so every time in it stays where it was.
//
// Pure: no DOM, so the importers can use it on archive bytes and the tests run
// in node. The reference the decoders are tested against is libsndfile's
// (adpcm-fixtures/make_fixtures.py).

const WAV_PCM = 0x0001;
export const WAV_MS_ADPCM = 0x0002;
const WAV_FLOAT = 0x0003;
export const WAV_IMA_ADPCM = 0x0011;
const WAV_EXTENSIBLE = 0xfffe;

const CODING_NAMES = {
  [WAV_MS_ADPCM]: 'MS ADPCM',
  0x0006: 'A-law',
  0x0007: 'mu-law',
  [WAV_IMA_ADPCM]: 'IMA ADPCM',
  0x0031: 'GSM 6.10',
  0x0040: 'G.721 ADPCM',
  0x0045: 'G.726 ADPCM',
  0x0050: 'MPEG',
  0x0055: 'MP3',
};

/** A name for a WAV coding a person may recognize, for a refusal. */
export const wavCodingName = (tag) =>
  CODING_NAMES[tag] ?? `format 0x${tag.toString(16).padStart(4, '0')}`;

const ascii = (bytes, at) =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

/**
 * The `fmt ` and `data` chunks of a RIFF/WAVE file, read through
 * `read(from, to)` (a Promise of a Uint8Array of those bytes, shorter at the
 * end of the file) over a file of `size` bytes. Only chunk headers and the
 * `fmt ` body are read, so a large recording costs a few small reads.
 *
 * Returns null when the bytes are not a WAV or have no `fmt ` chunk, else
 * `{ tag, formatTag, channels, sampleRate, blockAlign, bitsPerSample,
 *    samplesPerBlock, coefficients, dataOffset, dataSize }`.
 * `tag` is the coding: the subformat's for WAVE_FORMAT_EXTENSIBLE, which is
 * `formatTag` there. `coefficients` is MS ADPCM's table when the chunk has
 * one. `dataOffset` is null when there is no `data` chunk.
 */
export async function readWavInfo(read, size) {
  const head = await read(0, 12);
  if (head.length < 12 || ascii(head, 0) !== 'RIFF' || ascii(head, 8) !== 'WAVE') return null;
  let info = null;
  let dataOffset = null;
  let dataSize = 0;
  let at = 12;
  while (at + 8 <= size && !(info && dataOffset != null)) {
    const chunk = await read(at, at + 8);
    if (chunk.length < 8) break;
    const view = new DataView(chunk.buffer, chunk.byteOffset, 8);
    const id = ascii(chunk, 0);
    const length = view.getUint32(4, true);
    if (id === 'fmt ') {
      info = parseFmt(await read(at + 8, at + 8 + Math.min(length, 1024)));
      if (!info) return null;
    } else if (id === 'data') {
      dataOffset = at + 8;
      // A writer that never went back to fill the size in leaves 0 or ~0.
      dataSize = Math.min(length || size, size - dataOffset);
    }
    at += 8 + length + (length & 1);
  }
  if (!info) return null;
  return { ...info, dataOffset, dataSize };
}

function parseFmt(body) {
  if (body.length < 16) return null;
  const view = new DataView(body.buffer, body.byteOffset, body.length);
  const formatTag = view.getUint16(0, true);
  const channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const blockAlign = view.getUint16(12, true);
  const bitsPerSample = view.getUint16(14, true);
  const extraSize = body.length >= 18 ? view.getUint16(16, true) : 0;
  const extra = body.subarray(18, 18 + Math.min(extraSize, body.length - 18));
  const extraView = new DataView(extra.buffer, extra.byteOffset, extra.length);
  let tag = formatTag;
  let samplesPerBlock = null;
  let coefficients = null;
  if (formatTag === WAV_EXTENSIBLE) {
    // wValidBitsPerSample / wSamplesPerBlock, dwChannelMask, then the GUID,
    // whose first two bytes are the coding's tag.
    if (extra.length < 22)
      return {
        formatTag,
        tag: null,
        channels,
        sampleRate,
        blockAlign,
        bitsPerSample,
        samplesPerBlock,
        coefficients,
      };
    tag = extraView.getUint16(6, true);
    samplesPerBlock = extraView.getUint16(0, true) || null;
  } else if (formatTag === WAV_IMA_ADPCM || formatTag === WAV_MS_ADPCM) {
    if (extra.length >= 2) samplesPerBlock = extraView.getUint16(0, true) || null;
    if (formatTag === WAV_MS_ADPCM && extra.length >= 4) {
      const count = extraView.getUint16(2, true);
      if (count > 0 && extra.length >= 4 + count * 4) {
        coefficients = [];
        for (let i = 0; i < count; i += 1) {
          coefficients.push([
            extraView.getInt16(4 + i * 4, true),
            extraView.getInt16(6 + i * 4, true),
          ]);
        }
      }
    }
  }
  return {
    formatTag,
    tag,
    channels,
    sampleRate,
    blockAlign,
    bitsPerSample,
    samplesPerBlock,
    coefficients,
  };
}

/**
 * What to do with a WAV of this coding:
 *   'play'    — PCM or float, which browsers play
 *   'convert' — ADPCM this module decodes
 *   'refuse'  — anything else
 */
export function wavVerdict(info) {
  if (!info) return 'play';
  if (info.tag === WAV_PCM || info.tag === WAV_FLOAT) return 'play';
  if (
    (info.tag === WAV_IMA_ADPCM || info.tag === WAV_MS_ADPCM) &&
    info.bitsPerSample === 4 &&
    info.channels >= 1 &&
    info.blockAlign > 7 * info.channels &&
    info.dataOffset != null
  ) {
    return 'convert';
  }
  return 'refuse';
}

// IMA ADPCM, as Microsoft's WAV form of it lays it out: per block a header for
// each channel (first sample, step index), then the channels' nibbles in
// 4-byte runs of 8 samples each, low nibble first.

const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

function decodeImaBlock(block, channels, frames, out, outFrame) {
  const view = new DataView(block.buffer, block.byteOffset, block.length);
  const pred = [];
  const index = [];
  for (let c = 0; c < channels; c += 1) {
    pred.push(view.getInt16(c * 4, true));
    index.push(Math.min(88, Math.max(0, block[c * 4 + 2])));
    out[outFrame * channels + c] = pred[c];
  }
  let at = 4 * channels;
  // Each round: 4 bytes (8 samples) per channel.
  for (let frame = 1; frame < frames; frame += 8) {
    for (let c = 0; c < channels; c += 1) {
      for (let i = 0; i < 8; i += 1) {
        const f = frame + i;
        const byte = block[at + (i >> 1)];
        if (f < frames && byte !== undefined) {
          const nibble = i & 1 ? byte >> 4 : byte & 0x0f;
          const step = IMA_STEP[index[c]];
          let diff = step >> 3;
          if (nibble & 1) diff += step >> 2;
          if (nibble & 2) diff += step >> 1;
          if (nibble & 4) diff += step;
          pred[c] = clamp16(nibble & 8 ? pred[c] - diff : pred[c] + diff);
          index[c] = Math.min(88, Math.max(0, index[c] + IMA_INDEX[nibble]));
          out[(outFrame + f) * channels + c] = pred[c];
        }
      }
      at += 4;
    }
  }
}

// Microsoft ADPCM: per block a predictor choice, a delta and two samples per
// channel, the older sample first out, then signed nibbles high first, the
// channels taking turns.

const MS_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const MS_STANDARD_COEFFICIENTS = [
  [256, 0],
  [512, -256],
  [0, 0],
  [192, 64],
  [240, 0],
  [460, -208],
  [392, -232],
];

function decodeMsBlock(block, channels, frames, coefficients, out, outFrame) {
  const view = new DataView(block.buffer, block.byteOffset, block.length);
  const c1 = [];
  const c2 = [];
  const delta = [];
  const s1 = [];
  const s2 = [];
  for (let c = 0; c < channels; c += 1) {
    const [a, b] = coefficients[Math.min(block[c], coefficients.length - 1)];
    c1.push(a);
    c2.push(b);
    delta.push(view.getInt16(channels + c * 2, true));
    s1.push(view.getInt16(3 * channels + c * 2, true));
    s2.push(view.getInt16(5 * channels + c * 2, true));
    out[outFrame * channels + c] = s2[c];
    if (frames > 1) out[(outFrame + 1) * channels + c] = s1[c];
  }
  let at = 7 * channels;
  let high = true;
  for (let n = 2 * channels; n < frames * channels; n += 1) {
    if (at >= block.length) break;
    const c = n % channels;
    const raw = high ? block[at] >> 4 : block[at] & 0x0f;
    if (!high) at += 1;
    high = !high;
    const signed = raw & 8 ? raw - 16 : raw;
    let predicted = (s1[c] * c1[c] + s2[c] * c2[c]) >> 8;
    predicted = clamp16(predicted + signed * delta[c]);
    s2[c] = s1[c];
    s1[c] = predicted;
    delta[c] = (MS_ADAPT[raw] * delta[c]) >> 8;
    if (delta[c] < 16) delta[c] = 16;
    out[outFrame * channels + n] = predicted;
  }
}

/** Samples per channel in a full block, from the fmt chunk or its size. */
function blockFrames(info) {
  const { tag, channels, blockAlign } = info;
  const computed =
    tag === WAV_IMA_ADPCM
      ? ((blockAlign - 4 * channels) * 8) / (4 * channels) + 1
      : ((blockAlign - 7 * channels) * 2) / channels + 2;
  return info.samplesPerBlock && info.samplesPerBlock <= computed
    ? info.samplesPerBlock
    : Math.floor(computed);
}

/** Samples per channel a partial last block of `bytes` holds. */
function partialFrames(info, bytes) {
  const { tag, channels } = info;
  if (tag === WAV_IMA_ADPCM) {
    if (bytes < 4 * channels) return 0;
    return Math.floor((bytes - 4 * channels) / (4 * channels)) * 8 + 1;
  }
  if (bytes < 7 * channels) return 0;
  return Math.floor(((bytes - 7 * channels) * 2) / channels) + 2;
}

/**
 * Decode the ADPCM samples of a WAV whose `readWavInfo` is `info`, from
 * `data`, the bytes of its `data` chunk. Every block is decoded whole, as
 * libsndfile and ffmpeg do (the `fact` count is not trusted: libsndfile
 * writes half the true one for stereo IMA), and a partial last block as far
 * as it goes. Returns interleaved Int16 samples.
 */
function decodeAdpcm(info, data) {
  const { tag, channels, blockAlign } = info;
  const perBlock = blockFrames(info);
  const fullBlocks = Math.floor(data.length / blockAlign);
  const rest = data.length - fullBlocks * blockAlign;
  const lastFrames = Math.min(perBlock, partialFrames(info, rest));
  const total = fullBlocks * perBlock + lastFrames;
  const out = new Int16Array(total * channels);
  const coefficients = info.coefficients?.length ? info.coefficients : MS_STANDARD_COEFFICIENTS;
  const decodeBlock = (block, frames, outFrame) =>
    tag === WAV_IMA_ADPCM
      ? decodeImaBlock(block, channels, frames, out, outFrame)
      : decodeMsBlock(block, channels, frames, coefficients, out, outFrame);
  for (let b = 0; b < fullBlocks; b += 1) {
    decodeBlock(data.subarray(b * blockAlign, (b + 1) * blockAlign), perBlock, b * perBlock);
  }
  if (lastFrames > 0)
    decodeBlock(data.subarray(fullBlocks * blockAlign), lastFrames, fullBlocks * perBlock);
  return out;
}

/** A 16-bit PCM WAV of interleaved `samples`. */
function encodePcmWav(samples, channels, sampleRate) {
  const dataSize = samples.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const tag = (at, s) => {
    for (let i = 0; i < 4; i += 1) bytes[at + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, WAV_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataSize, true);
  // Little-endian whatever the machine, though every one this runs on is.
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

/** An ADPCM WAV's bytes as a 16-bit PCM WAV's, given its `readWavInfo`. */
export function adpcmWavToPcm(info, bytes) {
  const data = bytes.subarray(info.dataOffset, info.dataOffset + info.dataSize);
  return encodePcmWav(decodeAdpcm(info, data), info.channels, info.sampleRate);
}
