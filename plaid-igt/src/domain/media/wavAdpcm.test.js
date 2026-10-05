import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adpcmWavToPcm,
  readWavInfo,
  wavCodingName,
  wavVerdict,
  WAV_IMA_ADPCM,
  WAV_MS_ADPCM,
} from './wavAdpcm.js';

// The fixtures and their references are libsndfile's (adpcm-fixtures/
// make_fixtures.py): the decoder is held to a trusted implementation, sample
// for sample.

const fixture = (name) =>
  new Uint8Array(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'adpcm-fixtures', name)),
  );

/** The interleaved samples, channels and rate of a 16-bit PCM WAV. */
async function pcmOf(bytes) {
  const info = await readWavInfoFromBytes(bytes);
  expect(info.tag).toBe(1);
  expect(info.bitsPerSample).toBe(16);
  const data = bytes.slice(info.dataOffset, info.dataOffset + info.dataSize);
  return {
    samples: new Int16Array(data.buffer, 0, data.length / 2),
    channels: info.channels,
    sampleRate: info.sampleRate,
  };
}

const readWavInfoFromBytes = (bytes) =>
  readWavInfo(async (from, to) => bytes.subarray(from, Math.min(to, bytes.length)), bytes.length);

const CASES = [
  ['ima-mono.wav', 'ima-mono.ref.wav', WAV_IMA_ADPCM, 1],
  ['ima-stereo.wav', 'ima-stereo.ref.wav', WAV_IMA_ADPCM, 2],
  ['ms-mono.wav', 'ms-mono.ref.wav', WAV_MS_ADPCM, 1],
  ['ms-stereo.wav', 'ms-stereo.ref.wav', WAV_MS_ADPCM, 2],
  // WAVE_FORMAT_EXTENSIBLE with an ADPCM subformat, same samples.
  ['ima-mono-ext.wav', 'ima-mono.ref.wav', WAV_IMA_ADPCM, 1],
  ['ima-stereo-ext.wav', 'ima-stereo.ref.wav', WAV_IMA_ADPCM, 2],
  // No coefficient table in the extensible form: the standard seven.
  ['ms-mono-ext.wav', 'ms-mono.ref.wav', WAV_MS_ADPCM, 1],
];

describe('ADPCM WAV to PCM', () => {
  for (const [name, ref, tag, channels] of CASES) {
    it(`decodes ${name} exactly as libsndfile does`, async () => {
      const bytes = fixture(name);
      const info = await readWavInfoFromBytes(bytes);
      expect(info.tag).toBe(tag);
      expect(info.channels).toBe(channels);
      expect(wavVerdict(info)).toBe('convert');

      const got = await pcmOf(adpcmWavToPcm(info, bytes));
      const want = await pcmOf(fixture(ref));
      expect(got.channels).toBe(channels);
      expect(got.sampleRate).toBe(22050);
      expect(got.sampleRate).toBe(want.sampleRate);
      expect(got.samples.length).toBe(want.samples.length);
      let firstDiff = -1;
      for (let i = 0; i < want.samples.length; i += 1) {
        if (got.samples[i] !== want.samples[i]) {
          firstDiff = i;
          break;
        }
      }
      expect(firstDiff).toBe(-1);
    });
  }

  it('decodes a cut-off last block as far as it goes', async () => {
    const whole = fixture('ima-mono.wav');
    const info = await readWavInfoFromBytes(whole);
    // Half a block short, the data chunk's size left claiming the whole.
    const cut = whole.slice(0, whole.length - 256);
    const cutInfo = await readWavInfoFromBytes(cut);
    expect(cutInfo.dataSize).toBe(info.dataSize - 256);
    const got = await pcmOf(adpcmWavToPcm(cutInfo, cut));
    const want = await pcmOf(fixture('ima-mono.ref.wav'));
    // 6 whole blocks of 1017, then (256 - 4) bytes of nibbles and the header sample.
    expect(got.samples.length).toBe(6 * 1017 + 252 * 2 + 1);
    expect(Array.from(got.samples)).toEqual(
      Array.from(want.samples.subarray(0, got.samples.length)),
    );
  });

  it('keeps the duration: a time in the recording is the same time after', async () => {
    for (const [name] of CASES) {
      const bytes = fixture(name);
      const info = await readWavInfoFromBytes(bytes);
      const out = await pcmOf(adpcmWavToPcm(info, bytes));
      const blocks = info.dataSize / info.blockAlign;
      expect(out.samples.length / out.channels).toBe(blocks * info.samplesPerBlock);
      expect(out.sampleRate).toBe(info.sampleRate);
    }
  });
});

describe('wavVerdict', () => {
  it('plays PCM', async () => {
    expect(wavVerdict(await readWavInfoFromBytes(fixture('pcm.wav')))).toBe('play');
  });

  it('refuses codings it cannot decode, by name', async () => {
    const gsm = await readWavInfoFromBytes(fixture('gsm.wav'));
    const g721 = await readWavInfoFromBytes(fixture('g721.wav'));
    expect(wavVerdict(gsm)).toBe('refuse');
    expect(wavVerdict(g721)).toBe('refuse');
    expect(wavCodingName(gsm.tag)).toBe('GSM 6.10');
    expect(wavCodingName(g721.tag)).toBe('G.721 ADPCM');
    expect(wavCodingName(0x1234)).toBe('format 0x1234');
  });

  it('is not about files that are not WAV', async () => {
    const mp3ish = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await readWavInfoFromBytes(mp3ish)).toBeNull();
    expect(wavVerdict(null)).toBe('play');
  });

  it('finds the fmt chunk behind other chunks', async () => {
    const pcm = fixture('pcm.wav');
    // A LIST chunk of odd length (padded) ahead of fmt.
    const list = new Uint8Array([
      ...new TextEncoder().encode('LIST'),
      5,
      0,
      0,
      0,
      1,
      2,
      3,
      4,
      5,
      0,
    ]);
    const bytes = new Uint8Array(pcm.length + list.length);
    bytes.set(pcm.subarray(0, 12));
    bytes.set(list, 12);
    bytes.set(pcm.subarray(12), 12 + list.length);
    const info = await readWavInfoFromBytes(bytes);
    expect(info.tag).toBe(1);
    expect(info.dataOffset).toBe(12 + list.length + 16 + 8 + 8);
  });
});
