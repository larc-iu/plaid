import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Drawing the timeline's waveform. Decoding a recording is the slow half and
// the only asynchronous one, so it is the only place the hook can fall behind
// the recording on screen.
//
// The end state hides that entirely: a decode that lands after the recording
// changed draws the wrong waveform, and the next scroll or zoom quietly draws
// the right one over it. What is asserted here is the sequence of pictures the
// timeline actually DREW.
//
// The arithmetic (peaks, windows, bars) is waveform.js's own test. Here it is
// the seam, so a channel's samples ARE the bar heights and the drawn image is
// readable as the numbers that went into it.

const { notifyWarning } = vi.hoisted(() => ({ notifyWarning: vi.fn() }));
vi.mock('@/utils/feedback', () => ({ notifyWarning }));
vi.mock('./waveform.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peaksOfInSlices: async (channels) => ({ peaks: channels[0], level: 1 }),
  barsFor: ({ peaks }) => [...peaks].map((h, i) => ({ x: i, y: 0, width: 1, height: h })),
}));

// The decode is the shared mono 16 kHz one speech detection uses
// (sharedDecode.js): 8 kHz drew fricatives as silence (REV-MEDIA-1), and the
// device rate ran out of memory on a long recording (H22-MEDIA-5).
const { decodeShared, shareCalls } = vi.hoisted(() => {
  const shareCalls = [];
  return {
    shareCalls,
    decodeShared: vi.fn((blob) => {
      let finish;
      const promise = new Promise((resolve) => {
        finish = resolve;
      });
      shareCalls.push({ blob, promise, finish });
      return promise;
    }),
  };
});
vi.mock('../../../domain/vad/sharedDecode.js', () => ({ decodeShared }));

const { useWaveform, drawWaveform } = await import('./useWaveform.js');
const { encodeWav } = await import('../../../domain/media/wavFixture.js');

// A recording, named by its versioned URL (which is also the envelope cache's
// key, so every test needs its own).
let nextKey = 1000;
// Its bytes are no WAV, so it goes to the decoder.
const recording = (key = `/media?v=${(nextKey += 1)}`) => ({
  key,
  size: 5000,
  slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(12)) }),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
});

// One deferred per decode, so two can be in flight at once and land out of
// order.
let decodes;
const decoded = (samples) => ({ samples: Float32Array.from(samples), shared: false });

let api;
let seq;

// A canvas that keeps the heights of the bars drawn on it.
const fakeCanvas = () => {
  const bars = [];
  return {
    bars,
    width: 0,
    height: 0,
    getContext: () => ({ scale() {}, fillStyle: '', fillRect: (x, y, w, h) => bars.push(h) }),
  };
};

// Every DISTINCT picture the timeline has drawn, in order, as the timeline
// draws it: the hook's envelope onto a canvas.
const Probe = ({ blob, pixelsPerSecond = 200 }) => {
  const view = useWaveform({ mediaBlob: blob, mediaKey: blob?.key ?? null, duration: 2 });
  api = view;
  useEffect(() => {
    if (!view.envelope) return;
    const canvas = fakeCanvas();
    drawWaveform(canvas, view.envelope, { from: 0, to: 2, duration: 2, pixelsPerSecond });
    const picture = `drawn:${canvas.bars.join(',')}`;
    if (seq[seq.length - 1] !== picture) seq.push(picture);
  });
  return null;
};

const settle = (view) =>
  view.step(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  shareCalls.length = 0;
  decodes = shareCalls;
  seq = [];
  notifyWarning.mockClear();
  decodeShared.mockClear();
  // No decode of its own at any rate: a full-rate one ran out of memory.
  window.AudioContext = undefined;
  window.OfflineAudioContext = undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('the timeline waveform', () => {
  it('draws the recording it was given', async () => {
    const view = await renderComponent(<Probe blob={recording()} />);
    expect(api.loading).toBe(true);
    await view.step(() => decodes[0].finish(decoded([1, 2, 3])));
    await settle(view);
    expect(seq).toEqual(['drawn:1,2,3']);
    expect(api.loading).toBe(false);
    await view.unmount();
  });

  it('never draws a decode the recording has moved on from', async () => {
    const first = recording();
    const second = recording();
    const view = await renderComponent(<Probe blob={first} />);
    await view.rerender(<Probe blob={second} />);
    expect(decodes).toHaveLength(2);

    // The recording on screen finishes decoding first, then the one it
    // replaced.
    await view.step(() => decodes[1].finish(decoded([7, 8, 9])));
    await settle(view);
    await view.step(() => decodes[0].finish(decoded([1, 2, 3])));
    await settle(view);

    expect(seq).toEqual(['drawn:7,8,9']);
    await view.unmount();
  });

  it('keeps the envelope of the recording on screen when an abandoned decode lands', async () => {
    // Two fetches of one recording, so both passes share the envelope cache's
    // key (its versioned URL). The samples differ only so the test can tell
    // which pass's envelope was kept.
    const first = recording('/media?v=same');
    const second = recording('/media?v=same');
    const view = await renderComponent(<Probe blob={first} />);
    await view.rerender(<Probe blob={second} />);

    await view.step(() => decodes[1].finish(decoded([7, 8, 9])));
    await settle(view);
    await view.step(() => decodes[0].finish(decoded([1, 2, 3])));
    await settle(view);

    // A scroll or a zoom on the recording that is up. It must be drawn from
    // its own amplitudes, not from the ones the abandoned decode left behind.
    await view.rerender(<Probe blob={second} pixelsPerSecond={300} />);
    await settle(view);
    expect(seq).toEqual(['drawn:7,8,9']);
    await view.unmount();
  });

  it('leaves the spinner to the draw that replaced it', async () => {
    // A cancelled draw clearing `loading` flashes an empty timeline between two
    // recordings, which is exactly what the flag is there to cover.
    const first = recording();
    const second = recording();
    const view = await renderComponent(<Probe blob={first} />);
    await view.rerender(<Probe blob={second} />);

    await view.step(() => decodes[0].finish(decoded([1, 2, 3])));
    await settle(view);
    expect(api.loading).toBe(true);

    await view.step(() => decodes[1].finish(decoded([7, 8, 9])));
    await settle(view);
    expect(api.loading).toBe(false);
    await view.unmount();
  });

  it("never draws another recording's waveform for one of the same length", async () => {
    // A replaced recording, or another document's, of the same byte length and
    // duration: two takes cut to one length are routine.
    const first = recording();
    const second = recording();
    const view = await renderComponent(<Probe blob={first} />);
    await view.step(() => decodes[0].finish(decoded([1, 2, 3])));
    await settle(view);
    await view.rerender(<Probe blob={second} />);
    expect(decodes).toHaveLength(2);
    await view.step(() => decodes[1].finish(decoded([7, 8, 9])));
    await settle(view);
    expect(seq).toEqual(['drawn:1,2,3', 'drawn:7,8,9']);
    await view.unmount();
  });

  it('draws from the shared 16 kHz decode speech detection uses', async () => {
    const blob = recording();
    const view = await renderComponent(<Probe blob={blob} />);
    await view.step(() => decodes[0].finish(decoded([1, 2, 3])));
    await settle(view);
    expect(decodeShared).toHaveBeenCalledWith(blob, { perChannel: false });
    expect(seq).toEqual(['drawn:1,2,3']);
    await view.unmount();
  });

  it('says once that a recording could not be decoded, not on every redraw', async () => {
    const blob = recording();
    const view = await renderComponent(<Probe blob={blob} />);
    await view.step(() => decodes[0].finish(Promise.reject(new Error('Unable to decode'))));
    await settle(view);
    await view.rerender(<Probe blob={blob} pixelsPerSecond={300} />);
    await settle(view);
    await view.rerender(<Probe blob={blob} pixelsPerSecond={400} />);
    await settle(view);
    expect(decodes).toHaveLength(1);
    expect(notifyWarning).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});

// A recording with a speaker on each channel is drawn as a lane per channel,
// so the hook asks the decode for the channels and makes an envelope of each.
const ProbeChannels = ({ blob }) => {
  const view = useWaveform({
    mediaBlob: blob,
    mediaKey: blob?.key ?? null,
    duration: 2,
    perChannel: true,
  });
  api = view;
  useEffect(() => {
    const picture = view.envelopes
      ? `lanes:${view.envelopes.map((e) => [...e.peaks].join('.')).join('|')}:${view.channelCount}`
      : `mono:${view.channelCount}`;
    if (seq[seq.length - 1] !== picture) seq.push(picture);
  });
  return null;
};

describe('the waveform per channel', () => {
  it('asks for the channels and draws a lane each, with the count', async () => {
    const blob = recording();
    const view = await renderComponent(<ProbeChannels blob={blob} />);
    expect(decodeShared).toHaveBeenCalledWith(blob, { perChannel: true });
    await view.step(() =>
      decodes[0].finish({
        samples: Float32Array.from([1, 1]),
        channels: [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
        channelCount: 2,
        shared: false,
      }),
    );
    await settle(view);
    expect(seq[seq.length - 1]).toBe('lanes:1.0|0.1:2');
    expect(api.envelope.peaks.length).toBe(2);
    await view.unmount();
  });

  it('a recording with one channel has no lanes, and says one channel', async () => {
    const view = await renderComponent(<ProbeChannels blob={recording()} />);
    await view.step(() =>
      decodes[0].finish({
        samples: Float32Array.from([1]),
        channels: null,
        channelCount: 1,
        shared: false,
      }),
    );
    await settle(view);
    expect(seq[seq.length - 1]).toBe('mono:1');
    expect(api.envelopes).toBeNull();
    await view.unmount();
  });
});

// A recording stored as a PCM WAV (every one with a speaker per channel is)
// is drawn from its bytes, read a slice at a time. Decoding it took the whole
// file and every sample at once: about 3.7 GB for an hour at 48 kHz in stereo.
describe('the waveform of a PCM WAV', () => {
  // Reading a Blob is real I/O, a few ticks rather than a microtask.
  const drawn = async (view) => {
    for (let i = 0; i < 100 && api.loading; i += 1) {
      await view.step(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    expect(api.loading).toBe(false);
  };
  const wavBlob = (channels, rate) => {
    const blob = new Blob([encodeWav(channels, rate)], { type: 'audio/wav' });
    blob.key = `/media?v=${(nextKey += 1)}`;
    return blob;
  };

  it('draws a lane per channel from the bytes, and never decodes', async () => {
    // Two seconds at 8 kHz: Ana loud in the first, Ben in the second.
    const ana = Float32Array.from({ length: 16000 }, (_, i) => (i < 8000 ? 0.5 : 0));
    const ben = Float32Array.from({ length: 16000 }, (_, i) => (i < 8000 ? 0 : 0.5));
    const view = await renderComponent(<ProbeChannels blob={wavBlob([ana, ben], 8000)} />);
    await drawn(view);
    expect(decodeShared).not.toHaveBeenCalled();
    expect(api.channelCount).toBe(2);
    const [a, b] = api.envelopes;
    expect(a.peaks.length).toBe(2000);
    expect(a.peaks[500]).toBeCloseTo(0.5, 3);
    expect(a.peaks[1500]).toBe(0);
    expect(b.peaks[500]).toBe(0);
    expect(b.peaks[1500]).toBeCloseTo(0.5, 3);
    expect(api.envelope.peaks[500]).toBeCloseTo(0.25, 3);
    await view.unmount();
  });

  it('draws a plain recording from the bytes too, with no lanes', async () => {
    const tone = Float32Array.from({ length: 16000 }, (_, i) => 0.5 * Math.sin(i / 3));
    const view = await renderComponent(<Probe blob={wavBlob([tone, tone], 8000)} />);
    await drawn(view);
    expect(decodeShared).not.toHaveBeenCalled();
    expect(api.envelopes).toBeNull();
    expect(api.envelope.peaks[1000]).toBeGreaterThan(0.4);
    await view.unmount();
  });
});
