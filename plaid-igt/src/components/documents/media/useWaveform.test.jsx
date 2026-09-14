import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, useRef } from 'react';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Drawing the timeline's waveform. Decoding a recording is the slow half and
// the only asynchronous one, so it is the only place the hook can fall behind
// the recording on screen.
//
// The end state hides that entirely: a decode that lands after the recording
// changed draws the wrong waveform, and the next scroll or zoom quietly draws
// the right one over it. What is asserted here is the sequence of images the
// timeline actually SHOWED.
//
// The arithmetic (peaks, windows, bars) is waveform.js's own test. Here it is
// the seam, so a channel's samples ARE the bar heights and the drawn image is
// readable as the numbers that went into it.

vi.mock('@/utils/feedback', () => ({ notifyWarning: vi.fn() }));
vi.mock('./waveform.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peaksOf: (channels) => ({ peaks: channels[0], level: 1 }),
  barsFor: ({ peaks }) => [...peaks].map((h, i) => ({ x: i, y: 0, width: 1, height: h })),
}));

const { useWaveform } = await import('./useWaveform.js');

// A recording, identified by byte length (which is also the envelope cache's
// key, so every test needs its own).
let nextSize = 1000;
const recording = () => {
  nextSize += 1;
  return { size: nextSize, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
};

// One deferred per decode, so two can be in flight at once and land out of
// order.
let decodes;
const decoded = (samples) => ({
  numberOfChannels: 1,
  getChannelData: () => Float32Array.from(samples),
});

let api;
let seq;

// Every DISTINCT image the timeline has shown, in order.
const Probe = ({ blob, timelineWidth = 400 }) => {
  const containerRef = useRef({ clientWidth: 300 });
  const view = useWaveform({
    mediaBlob: blob,
    duration: 2,
    timelineWidth,
    scrollLeft: 0,
    containerRef,
  });
  api = view;
  useEffect(() => {
    if (view.image && seq[seq.length - 1] !== view.image) seq.push(view.image);
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
  decodes = [];
  seq = [];
  window.AudioContext = class {
    decodeAudioData() {
      let finish;
      const promise = new Promise((resolve) => {
        finish = resolve;
      });
      decodes.push({ promise, finish });
      return promise;
    }
  };
  URL.createObjectURL = (blob) => `drawn:${blob.tag}`;
  URL.revokeObjectURL = () => {};
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag) => {
    if (tag !== 'canvas') return realCreateElement(tag);
    const bars = [];
    return {
      width: 0,
      height: 0,
      getContext: () => ({ scale() {}, fillStyle: '', fillRect: (x, y, w, h) => bars.push(h) }),
      toBlob: (cb) => cb({ tag: bars.join(',') }),
    };
  });
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
    // key (byte length and duration). The samples differ only so the test can
    // tell which pass's envelope was kept.
    const first = { size: 5000, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
    const second = { size: 5000, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
    const view = await renderComponent(<Probe blob={first} />);
    await view.rerender(<Probe blob={second} />);

    await view.step(() => decodes[1].finish(decoded([7, 8, 9])));
    await settle(view);
    await view.step(() => decodes[0].finish(decoded([1, 2, 3])));
    await settle(view);

    // A scroll or a zoom on the recording that is up. It must be drawn from
    // its own amplitudes, not from the ones the abandoned decode left behind.
    await view.rerender(<Probe blob={second} timelineWidth={600} />);
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
});
