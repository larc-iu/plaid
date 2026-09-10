import { describe, it, expect } from 'vitest';
import { barsFor, covers, peaksOf, windowFor } from './waveform.js';

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

describe('windowFor', () => {
  it('reaches a screen either side, clamped to the timeline', () => {
    expect(windowFor(5000, 1000, 20000)).toEqual({ left: 4000, width: 3000 });
    expect(windowFor(0, 1000, 20000)).toEqual({ left: 0, width: 2000 });
    expect(windowFor(19000, 1000, 20000)).toEqual({ left: 18000, width: 2000 });
    // Shorter than one screen: the whole thing.
    expect(windowFor(0, 1000, 400)).toEqual({ left: 0, width: 400 });
  });
});

describe('covers', () => {
  const drawn = { left: 4000, width: 3000 };
  it('holds while the viewport is inside what was drawn', () => {
    expect(covers(drawn, 5000, 1000)).toBe(true);
    expect(covers(drawn, 4000, 1000)).toBe(true);
    expect(covers(drawn, 6000, 1000)).toBe(true);
  });
  it('fails once the viewport runs off either edge', () => {
    expect(covers(drawn, 3999, 1000)).toBe(false);
    expect(covers(drawn, 6001, 1000)).toBe(false);
    expect(covers({ left: 0, width: 0 }, 0, 1000)).toBe(false);
  });
});

// The point of drawing only a window is that a bar still lands on the time it
// belongs to. Get this wrong and the waveform lies about where a boundary is,
// which is worse than the blur it replaced.
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
