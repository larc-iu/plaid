import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeWav } from './mixdown.js';
import { readChannelCount } from './mixRecordings.js';

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
