import { describe, it, expect, vi, afterEach } from 'vitest';
import { mixBytes } from './mixdown.js';
import { encodeWav } from './wavFixture.js';
import { mixTracks, readChannelCount, readTrack } from './mixRecordings.js';

// How many channels a single file has, for a file with a speaker per channel:
// off a WAV's header without decoding it, else from the browser's decode.

afterEach(() => vi.unstubAllGlobals());

const wavOf = (channels) =>
  new File(
    [
      encodeWav(
        Array.from({ length: channels }, () => new Float32Array(8)),
        16000,
      ),
    ],
    'rec.wav',
    { type: 'audio/wav' },
  );

describe('readChannelCount', () => {
  it('reads a WAV header without decoding', async () => {
    const decodeAudioData = vi.fn();
    vi.stubGlobal('window', {
      OfflineAudioContext: class {
        decodeAudioData = decodeAudioData;
      },
    });
    expect(await readChannelCount(wavOf(1))).toBe(1);
    expect(await readChannelCount(wavOf(2))).toBe(2);
    expect(await readChannelCount(wavOf(4))).toBe(4);
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('asks the decoder for anything else', async () => {
    vi.stubGlobal('window', {
      OfflineAudioContext: class {
        async decodeAudioData() {
          return { numberOfChannels: 3 };
        }
      },
    });
    const mp3 = new File([new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0])], 'rec.mp3', {
      type: 'audio/mpeg',
    });
    expect(await readChannelCount(mp3)).toBe(3);
  });
});

// A decoder that hears each file as `channels` at whatever rate it is asked
// for: a file's samples are its `voice` value repeated, one second long. It
// records each decode's rate and the order of starts and finishes.
const stubDecoder = (events) => {
  const pending = [];
  vi.stubGlobal('window', {
    OfflineAudioContext: class {
      constructor(_channels, _length, rate) {
        this.rate = rate;
      }
      async decodeAudioData(bytes) {
        const name = new TextDecoder().decode(bytes);
        events.push(`start ${name} @${this.rate}`);
        await new Promise((ok) => pending.push(ok));
        const voice = Number(name.split(':')[1]);
        const channels = Number(name.split(':')[2] || 1);
        const data = Array.from({ length: channels }, (_, c) =>
          new Float32Array(this.rate).fill(c === 0 ? voice : 0),
        );
        events.push(`decoded ${name}`);
        return {
          sampleRate: this.rate,
          numberOfChannels: channels,
          duration: 1,
          getChannelData: (c) => data[c],
        };
      }
    },
  });
  // Lets the oldest waiting decode finish.
  return async () => {
    for (let i = 0; i < 50 && !pending.length; i += 1) await new Promise((ok) => setTimeout(ok));
    pending.shift()?.();
    await new Promise((ok) => setTimeout(ok));
  };
};
const audio = (name) => new File([name], name.split(':')[0], { type: 'audio/ogg' });

describe('readTrack', () => {
  it('keeps the length, channels and rate, and none of the samples', async () => {
    const finish = stubDecoder([]);
    const reading = readTrack(audio('ana:0.5:2'));
    await finish();
    const read = await reading;
    expect(read).toEqual({ name: 'ana', sampleRate: 48000, channels: 2, seconds: 1 });
  });

  it('decodes one file at a time, and skips a read whose signal is aborted', async () => {
    const events = [];
    const finish = stubDecoder(events);
    const abort = new AbortController();
    const caught = (p) =>
      p.then(
        () => null,
        (e) => e,
      );
    const first = caught(readTrack(audio('ana:0.5'), { signal: abort.signal }));
    const second = readTrack(audio('ben:0.5'));
    const third = caught(readTrack(audio('cid:0.5'), { signal: abort.signal }));
    await new Promise((ok) => setTimeout(ok, 10));
    expect(events).toEqual(['start ana:0.5 @48000']);
    abort.abort();
    await finish();
    expect((await first)?.name).toBe('AbortError');
    await finish();
    await second;
    expect((await third)?.name).toBe('AbortError');
    expect(events).toEqual([
      'start ana:0.5 @48000',
      'decoded ana:0.5',
      'start ben:0.5 @48000',
      'decoded ben:0.5',
    ]);
  });
});

describe('mixTracks', () => {
  const pcm = (bytes, at) => new DataView(bytes.buffer).getInt16(at, true);

  it('decodes each file at the mix rate after the one before is written, and makes the stated size', async () => {
    const events = [];
    const finish = stubDecoder(events);
    const tracks = [
      { file: audio('ana:0.5'), name: 'ana.wav', seconds: 1, sampleRate: 48000, offset: 0 },
      { file: audio('ben:0.25:2'), name: 'ben.wav', seconds: 1, sampleRate: 44100, offset: 0.5 },
    ];
    const mixing = mixTracks(tracks, { quality: 'small' });
    await finish();
    await finish();
    const file = await mixing;
    expect(events).toEqual([
      'start ana:0.5 @16000',
      'decoded ana:0.5',
      'start ben:0.25:2 @16000',
      'decoded ben:0.25:2',
    ]);
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(bytes.length).toBe(mixBytes(tracks, 'small'));
    expect(file.name).toBe('ana (mixed, 2 speakers).wav');
    // 1.5 s at 16 kHz, two channels interleaved after a 44-byte header.
    const frame = (i) => 44 + i * 4;
    expect(pcm(bytes, frame(0))).toBe(Math.round(0.5 * 32767));
    expect(pcm(bytes, frame(0) + 2)).toBe(0);
    expect(pcm(bytes, frame(7999) + 2)).toBe(0);
    // ben starts at 0.5 s, its two channels averaged to one.
    expect(pcm(bytes, frame(8000) + 2)).toBe(Math.round(0.125 * 32767));
    expect(pcm(bytes, frame(15999))).toBe(Math.round(0.5 * 32767));
    expect(pcm(bytes, frame(16000))).toBe(0);
    expect(pcm(bytes, frame(23999) + 2)).toBe(Math.round(0.125 * 32767));
  });

  it('stops before the next file once its signal is aborted', async () => {
    const events = [];
    const finish = stubDecoder(events);
    const abort = new AbortController();
    const tracks = ['ana', 'ben'].map((n) => ({
      file: audio(`${n}:0.5`),
      name: n,
      seconds: 1,
      sampleRate: 16000,
      offset: 0,
    }));
    const mixing = mixTracks(tracks, { signal: abort.signal }).then(
      () => null,
      (e) => e,
    );
    await new Promise((ok) => setTimeout(ok, 10));
    abort.abort();
    await finish();
    expect((await mixing)?.name).toBe('AbortError');
    expect(events).toEqual(['start ana:0.5 @16000', 'decoded ana:0.5']);
  });
});
