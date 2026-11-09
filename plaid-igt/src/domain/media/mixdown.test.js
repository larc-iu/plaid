import { describe, it, expect } from 'vitest';
import {
  SMALL_RATE,
  averageChannels,
  encodeWav,
  mixBytes,
  mixName,
  mixRate,
  mixSeconds,
  placeTrack,
  trackNote,
  wavHeaderBytes,
} from './mixdown.js';
import { readWavInfo, wavVerdict } from './wavAdpcm.js';

const reader = (bytes) => async (from, to) => bytes.subarray(from, Math.min(to, bytes.length));

describe('the plan of a mix', () => {
  const tracks = [
    { seconds: 10, sampleRate: 44100, offset: 0 },
    { seconds: 8, sampleRate: 48000, offset: 3 },
  ];

  it('runs as long as the longest file plus its offset', () => {
    expect(mixSeconds(tracks)).toBe(11);
    // A negative offset trims the file's start, so it ends sooner.
    expect(mixSeconds([{ seconds: 10, offset: -2 }])).toBe(8);
    expect(mixSeconds([])).toBe(0);
  });

  it('takes the highest rate at full quality and 16 kHz for the smaller mix', () => {
    expect(mixRate(tracks, 'full')).toBe(48000);
    expect(mixRate(tracks, 'small')).toBe(SMALL_RATE);
    expect(mixRate([{ seconds: 1 }], 'full')).toBe(48000);
  });

  it('counts the bytes of the WAV before it is made', () => {
    // 11 s at 48 kHz, two channels, 16-bit, plus the plain header.
    expect(mixBytes(tracks, 'full')).toBe(44 + 11 * 48000 * 2 * 2);
    expect(mixBytes(tracks, 'small')).toBe(44 + 11 * 16000 * 2 * 2);
    expect(mixBytes([...tracks, { seconds: 1, sampleRate: 16000 }], 'small')).toBe(
      68 + 11 * 16000 * 3 * 2,
    );
    expect(mixBytes([], 'full')).toBe(0);
  });

  it('is named after the first file and says it is mixed', () => {
    expect(mixName('ana.wav', 2)).toBe('ana (mixed, 2 speakers).wav');
    expect(mixName('session.m4a', 3)).toBe('session (mixed, 3 speakers).wav');
    expect(mixName('', 2)).toBe('recording (mixed, 2 speakers).wav');
  });

  it('says what each input is', () => {
    expect(trackNote({ channels: 1, sampleRate: 44100 })).toBe('mono · 44.1 kHz');
    expect(trackNote({ channels: 2, sampleRate: 48000 })).toBe(
      'stereo, mixed to one channel · 48 kHz',
    );
    expect(trackNote({ channels: 4, sampleRate: 16000 })).toBe(
      '4 channels, mixed to one channel · 16 kHz',
    );
  });
});

describe('placing a track', () => {
  const samples = Float32Array.from([0.1, 0.2, 0.3, 0.4]);

  it('puts silence before it for a positive offset', () => {
    expect([...placeTrack(samples, 0.5, 4, 8)]).toEqual([0, 0, 0.1, 0.2, 0.3, 0.4, 0, 0].map(near));
  });

  it('cuts its start for a negative offset', () => {
    expect([...placeTrack(samples, -0.5, 4, 4)]).toEqual([0.3, 0.4, 0, 0].map(near));
  });

  it('never writes past the end of the mix', () => {
    expect([...placeTrack(samples, 0.75, 4, 4)]).toEqual([0, 0, 0, 0.1].map(near));
    expect([...placeTrack(samples, 2, 4, 4)]).toEqual([0, 0, 0, 0]);
  });

  it('averages channels to one', () => {
    const mono = averageChannels([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect([...mono]).toEqual([0.5, 0.5]);
    const one = Float32Array.from([0.3]);
    expect(averageChannels([one])).toBe(one);
  });
});

const near = (v) => expect.closeTo(v, 6);

describe('the WAV', () => {
  it('is plain 16-bit PCM up to two channels, and reads back as one', async () => {
    const left = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const right = Float32Array.from([1, 1, 1, 1, 1]);
    const bytes = encodeWav([left, right], 16000);
    expect(bytes.length).toBe(44 + 5 * 2 * 2);
    expect(wavHeaderBytes(2)).toBe(44);
    const info = await readWavInfo(reader(bytes), bytes.length);
    expect([info.channels, info.sampleRate, info.bitsPerSample]).toEqual([2, 16000, 16]);
    expect(wavVerdict(info)).toBe('play');
    const view = new DataView(bytes.buffer);
    // Interleaved: left, right, left, right…
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(16384);
    expect(view.getInt16(52, true)).toBe(-16383);
    expect(view.getInt16(56, true)).toBe(32767);
    expect(view.getInt16(60, true)).toBe(-32767);
  });

  it('is WAVE_FORMAT_EXTENSIBLE past two channels, with no channel mask, and still plays', async () => {
    const a = Float32Array.from([0.25, 0.25]);
    const bytes = encodeWav([a, a, a], 48000);
    expect(bytes.length).toBe(68 + 2 * 3 * 2);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(20, true)).toBe(0xfffe);
    expect(view.getUint32(16, true)).toBe(40);
    expect(view.getUint32(40, true)).toBe(0); // channel mask
    expect(view.getUint16(44, true)).toBe(1); // PCM subformat
    expect(String.fromCharCode(...bytes.subarray(60, 64))).toBe('data');
    expect(view.getUint32(64, true)).toBe(12);
    const info = await readWavInfo(reader(bytes), bytes.length);
    expect([info.channels, info.sampleRate, info.bitsPerSample]).toEqual([3, 48000, 16]);
    expect(wavVerdict(info)).toBe('play');
  });

  it('clamps what is louder than full scale', () => {
    const view = new DataView(encodeWav([Float32Array.from([2, -2])], 8000).buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});
