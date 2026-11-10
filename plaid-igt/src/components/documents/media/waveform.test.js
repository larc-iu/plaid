import { describe, it, expect } from 'vitest';
import { barsFor, peaksOf, peaksOfInSlices, peaksOfPcmWav } from './waveform.js';
import { readWavInfo } from '../../../domain/media/wavAdpcm.js';
import { encodeWav } from '../../../domain/media/wavFixture.js';

const SR = 16000;
// Three seconds: silence, a loud second, silence.
const burst = () => {
  const data = new Float32Array(SR * 3);
  for (let i = SR; i < SR * 2; i += 1) data[i] = Math.sin((i / SR) * 2 * Math.PI * 220) * 0.8;
  return data;
};

describe('peaksOf', () => {
  it('puts the loud stretch where it happened', () => {
    const { peaks, level } = peaksOf([burst()], 3);
    const third = Math.floor(peaks.length / 3);
    const loudest = (from, to) => Math.max(...peaks.slice(from, to));
    expect(loudest(0, third - 2)).toBeLessThan(0.01);
    expect(loudest(third + 2, third * 2 - 2)).toBeGreaterThan(0.7);
    expect(loudest(third * 2 + 2, peaks.length)).toBeLessThan(0.01);
    expect(level).toBeGreaterThan(0);
  });

  it('scales against a percentile, so one spike does not flatten the speech', () => {
    const data = burst();
    data[10] = 1; // a single sample of clipping, in the silence
    const { peaks, level } = peaksOf([data], 3);
    expect(Math.max(...peaks)).toBe(1);
    expect(0.8 / level).toBeGreaterThan(0.9);
  });

  it('never returns an empty envelope or a zero level', () => {
    const { peaks, level } = peaksOf([new Float32Array(SR)], 1);
    expect(peaks.length).toBeGreaterThan(0);
    expect(level).toBeGreaterThan(0); // silence still divides safely
  });
});

// A camera with an external microphone: the speech is on one channel and the
// other holds only the camera's own noise floor. Drawn from the first channel
// alone and scaled to fill the picture, that floor looked like an unbroken
// wall of speech, on a recording whose speech detector was finding the real
// utterances perfectly well.
describe('peaksOf, across channels', () => {
  const hiss = () => {
    const data = new Float32Array(SR * 3);
    for (let i = 0; i < data.length; i += 1) data[i] = ((i * 7919) % 13) * 0.0002;
    return data;
  };

  it('hears the loud second on whichever channel carries it', () => {
    const { peaks, level } = peaksOf([hiss(), burst()], 3);
    const third = Math.floor(peaks.length / 3);
    const loudest = (from, to) => Math.max(...peaks.slice(from, to));
    expect(loudest(third + 2, third * 2 - 2)).toBeGreaterThan(0.7);
    expect(loudest(0, third - 2) / level).toBeLessThan(0.01);
  });

  it('leaves a recording with nothing in it flat rather than scaling up its noise', () => {
    const { peaks, level } = peaksOf([hiss(), hiss()], 3);
    expect(Math.max(...peaks) / level).toBeLessThan(0.5);
  });
});

describe('barsFor', () => {
  const { peaks, level } = peaksOf([burst()], 3);
  const tallest = (bars) => bars.reduce((a, b) => (b.height > a.height ? b : a));

  it('puts the loud second in the middle when the window is the whole timeline', () => {
    const bars = barsFor({ peaks, level, left: 0, width: 900, timelineWidth: 900, drawWidth: 900 });
    // 900px for 3s: the burst is the middle 300px.
    const peak = tallest(bars);
    expect(peak.x).toBeGreaterThan(300);
    expect(peak.x).toBeLessThan(600);
    expect(bars[0].height).toBeLessThan(peak.height);
  });

  it('puts it at the right place inside a window that covers only part', () => {
    // The middle third of the timeline: the burst fills this window.
    const bars = barsFor({
      peaks,
      level,
      left: 300,
      width: 300,
      timelineWidth: 900,
      drawWidth: 300,
    });
    const short = bars.filter((b) => b.height < 10).length;
    expect(short).toBeLessThan(bars.length * 0.1); // nearly all of it is loud
    // The last third is silence, and reads as silence.
    const quiet = barsFor({
      peaks,
      level,
      left: 600,
      width: 300,
      timelineWidth: 900,
      drawWidth: 300,
    });
    expect(Math.max(...quiet.map((b) => b.height))).toBeLessThan(10);
  });

  it('draws bars that tile the window, centred on its middle', () => {
    const bars = barsFor({ peaks, level, left: 0, width: 600, timelineWidth: 900, drawWidth: 600 });
    expect(bars[0].x).toBe(0);
    expect(bars[bars.length - 1].x).toBeLessThan(600);
    for (const bar of bars) expect(bar.y + bar.height / 2).toBeCloseTo(50, 5);
  });

  it('is empty rather than throwing when there is nothing to draw', () => {
    expect(
      barsFor({ peaks: null, level: 1, left: 0, width: 10, timelineWidth: 10, drawWidth: 10 }),
    ).toEqual([]);
    expect(barsFor({ peaks, level, left: 0, width: 10, timelineWidth: 0, drawWidth: 10 })).toEqual(
      [],
    );
  });
});

describe('peaksOfInSlices', () => {
  it('reads what peaksOf reads, handing the page back between slices', async () => {
    // Half a minute is 30,000 buckets: two slices.
    const samples = Float32Array.from(
      { length: 30 * 16000 },
      (_, i) => Math.sin(i / 7) * ((i % 9973) / 9973),
    );
    let pauses = 0;
    const sliced = await peaksOfInSlices([samples], 30, {
      pause: async () => {
        pauses += 1;
      },
    });
    const whole = peaksOf([samples], 30);
    expect(pauses).toBe(1);
    expect(sliced.level).toBe(whole.level);
    expect(Array.from(sliced.peaks)).toEqual(Array.from(whole.peaks));
  });
});

it('stops reading once the recording is no longer wanted', async () => {
  const samples = new Float32Array(90 * 16000);
  let pauses = 0;
  const out = await peaksOfInSlices([samples], 90, {
    pause: async () => {
      pauses += 1;
    },
    cancelled: () => pauses >= 1,
  });
  expect(out).toBeNull();
  expect(pauses).toBe(1);
});

describe('barsFor in a lane', () => {
  it('scales the bars to the lane and centres them in it', () => {
    const peaks = Float32Array.from([1, 1, 1, 1]);
    const whole = barsFor({ peaks, level: 1, left: 0, width: 4, timelineWidth: 4, drawWidth: 4 });
    const lane = barsFor({
      peaks,
      level: 1,
      left: 0,
      width: 4,
      timelineWidth: 4,
      drawWidth: 4,
      height: 50,
    });
    expect(whole[0].height).toBe(90);
    expect(whole[0].y).toBe(5);
    expect(lane[0].height).toBe(45);
    expect(lane[0].y).toBe(2.5);
  });
});

// A WAV of integer PCM or 32-bit float, the way a recorder writes one: a
// 44-byte header and the channels interleaved. `quantize` gives the stored
// value of a sample and `store` writes it.
const CODINGS = {
  pcm8: { tag: 1, bits: 8, put: (v, at, x) => v.setUint8(at, Math.round(x * 127) + 128) },
  pcm16: { tag: 1, bits: 16, put: (v, at, x) => v.setInt16(at, Math.round(x * 32767), true) },
  pcm24: {
    tag: 1,
    bits: 24,
    put: (v, at, x) => {
      const n = Math.round(x * 8388607);
      v.setUint8(at, n & 0xff);
      v.setUint8(at + 1, (n >> 8) & 0xff);
      v.setInt8(at + 2, n >> 16);
    },
  },
  pcm32: { tag: 1, bits: 32, put: (v, at, x) => v.setInt32(at, Math.round(x * 2147483647), true) },
  float32: { tag: 3, bits: 32, put: (v, at, x) => v.setFloat32(at, x, true) },
};
const wavOf = (channels, rate, { tag, bits, put }) => {
  const frames = channels[0].length;
  const block = (channels.length * bits) / 8;
  const bytes = new Uint8Array(44 + frames * block);
  const v = new DataView(bytes.buffer);
  const tagAt = (at, s) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  tagAt(0, 'RIFF');
  v.setUint32(4, 36 + frames * block, true);
  tagAt(8, 'WAVE');
  tagAt(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, tag, true);
  v.setUint16(22, channels.length, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, bits, true);
  tagAt(36, 'data');
  v.setUint32(40, frames * block, true);
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < channels.length; c += 1)
      put(v, 44 + f * block + (c * bits) / 8, channels[c][f]);
  }
  return bytes;
};
// The samples as a decoder hands them back from those bytes.
const decodedFrom = (bytes, info) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  const frames = info.dataSize / info.blockAlign;
  const size = info.bitsPerSample / 8;
  const one = (at) => {
    if (info.tag === 3) return v.getFloat32(at, true);
    if (size === 1) return (v.getUint8(at) - 128) / 128;
    if (size === 2) return v.getInt16(at, true) / 32768;
    if (size === 3)
      return ((v.getUint8(at) | (v.getUint8(at + 1) << 8)) + v.getInt8(at + 2) * 65536) / 8388608;
    return v.getInt32(at, true) / 2147483648;
  };
  return Array.from({ length: info.channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, f) =>
      one(info.dataOffset + f * info.blockAlign + c * size),
    ),
  );
};
const mixed = (channels) =>
  Float32Array.from(
    channels[0],
    (_, i) => channels.reduce((s, c) => s + c[i], 0) / channels.length,
  );
// Readings of `bytes` as a Blob gives them, and the longest one asked for.
const readerOf = (bytes) => {
  const reads = { longest: 0 };
  reads.read = async (from, to) => {
    reads.longest = Math.max(reads.longest, Math.min(to, bytes.length) - from);
    return bytes.slice(from, Math.min(to, bytes.length));
  };
  return reads;
};
// Largest difference between two envelopes, each taken against its level, as
// the bars are drawn.
const drawnDifference = (a, b) => {
  let worst = 0;
  for (let i = 0; i < a.peaks.length; i += 1) {
    const d = Math.abs(Math.min(1, a.peaks[i] / a.level) - Math.min(1, b.peaks[i] / b.level));
    if (d > worst) worst = d;
  }
  return worst;
};
const speech = (seconds, rate, seed) =>
  Float32Array.from({ length: seconds * rate }, (_, i) => {
    const t = i / rate;
    const on = Math.sin(t * (1.3 + seed)) > 0.2 ? 0.8 : 0.01;
    return (on * Math.sin(t * 2 * Math.PI * (180 + 60 * seed)) * ((i * (7 + seed)) % 11)) / 11;
  });

describe('peaksOfPcmWav', () => {
  for (const name of Object.keys(CODINGS)) {
    it(`reads a ${name} WAV straight from its bytes, as the decoded samples would draw`, async () => {
      const bytes = wavOf([speech(3, 8000, 0), speech(3, 8000, 1)], 8000, CODINGS[name]);
      const reads = readerOf(bytes);
      const info = await readWavInfo(reads.read, bytes.length);
      const out = await peaksOfPcmWav(reads.read, info, 3, { perChannel: true });
      const channels = decodedFrom(bytes, info);
      expect(out.channelCount).toBe(2);
      expect(out.envelope.peaks.length).toBe(3000);
      expect(drawnDifference(out.envelope, peaksOf([mixed(channels)], 3))).toBeLessThan(1e-5);
      expect(out.envelopes).toHaveLength(2);
      for (const c of [0, 1]) {
        expect(drawnDifference(out.envelopes[c], peaksOf([channels[c]], 3))).toBeLessThan(1e-5);
      }
    });
  }

  it('reads a mix of three speakers, written as an extensible WAV', async () => {
    const channels = [speech(2, 8000, 0), speech(2, 8000, 1), speech(2, 8000, 2)];
    const bytes = encodeWav(channels, 8000);
    const reads = readerOf(bytes);
    const info = await readWavInfo(reads.read, bytes.length);
    const out = await peaksOfPcmWav(reads.read, info, 2, { perChannel: true });
    const stored = decodedFrom(bytes, info);
    expect(out.channelCount).toBe(3);
    expect(drawnDifference(out.envelope, peaksOf([mixed(stored)], 2))).toBeLessThan(1e-5);
    for (const c of [0, 1, 2]) {
      expect(drawnDifference(out.envelopes[c], peaksOf([stored[c]], 2))).toBeLessThan(1e-5);
    }
  });

  it('keeps no lane per channel unless asked, nor for one channel', async () => {
    const stereo = wavOf([speech(1, 8000, 0), speech(1, 8000, 1)], 8000, CODINGS.pcm16);
    const s = readerOf(stereo);
    const plain = await peaksOfPcmWav(s.read, await readWavInfo(s.read, stereo.length), 1);
    expect(plain.envelopes).toBeNull();
    expect(plain.channelCount).toBe(2);
    const mono = wavOf([speech(1, 8000, 0)], 8000, CODINGS.pcm16);
    const m = readerOf(mono);
    const one = await peaksOfPcmWav(m.read, await readWavInfo(m.read, mono.length), 1, {
      perChannel: true,
    });
    expect(one.envelopes).toBeNull();
    expect(one.channelCount).toBe(1);
  });

  it('reads a long recording a slice at a time, never the whole file', async () => {
    // Fifty seconds at 8 kHz is 50,000 buckets: three slices.
    const bytes = wavOf([speech(50, 8000, 0), speech(50, 8000, 1)], 8000, CODINGS.pcm16);
    const reads = readerOf(bytes);
    const info = await readWavInfo(reads.read, bytes.length);
    let pauses = 0;
    const out = await peaksOfPcmWav(reads.read, info, 50, {
      perChannel: true,
      pause: async () => {
        pauses += 1;
      },
    });
    expect(pauses).toBe(2);
    expect(reads.longest).toBeLessThan(bytes.length / 2);
    const channels = decodedFrom(bytes, info);
    expect(drawnDifference(out.envelope, peaksOf([mixed(channels)], 50))).toBeLessThan(1e-5);
    expect(drawnDifference(out.envelopes[1], peaksOf([channels[1]], 50))).toBeLessThan(1e-5);
  });

  it('stops reading once the recording is no longer wanted', async () => {
    const bytes = wavOf([speech(50, 8000, 0)], 8000, CODINGS.pcm16);
    const reads = readerOf(bytes);
    const info = await readWavInfo(reads.read, bytes.length);
    let pauses = 0;
    const out = await peaksOfPcmWav(reads.read, info, 50, {
      pause: async () => {
        pauses += 1;
      },
      cancelled: () => pauses >= 1,
    });
    expect(out).toBeNull();
    expect(pauses).toBe(1);
  });

  it('is null for a coding it cannot read, which is then decoded', async () => {
    const bytes = wavOf([speech(1, 8000, 0)], 8000, CODINGS.pcm16);
    const v = new DataView(bytes.buffer);
    v.setUint16(20, 0x0011, true); // IMA ADPCM
    const reads = readerOf(bytes);
    const info = await readWavInfo(reads.read, bytes.length);
    expect(await peaksOfPcmWav(reads.read, info, 1)).toBeNull();
  });
});
