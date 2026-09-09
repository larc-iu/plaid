import { describe, it, expect } from 'vitest';
import { peaksOf } from './useTimelineOperations.js';

// The timeline waveform is drawn from this envelope, once per recording, and
// redrawn from it at every zoom level. What matters is that it tracks the
// signal: a boundary you can see is the whole reason to draw one.
describe('peaksOf', () => {
  const SR = 16000;
  // Two seconds: silence, a loud second, silence.
  const burst = () => {
    const data = new Float32Array(SR * 3);
    for (let i = SR; i < SR * 2; i += 1) data[i] = Math.sin((i / SR) * 2 * Math.PI * 220) * 0.8;
    return data;
  };

  it('puts the loud stretch where it happened', () => {
    const { peaks, level } = peaksOf(burst(), 3);
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
    const { peaks, level } = peaksOf(data, 3);
    // The spike is in the envelope, but the speech still fills the height.
    expect(Math.max(...peaks)).toBe(1);
    expect(0.8 / level).toBeGreaterThan(0.9);
  });

  it('never returns an empty envelope or a zero level', () => {
    const { peaks, level } = peaksOf(new Float32Array(SR), 1);
    expect(peaks.length).toBeGreaterThan(0);
    expect(level).toBe(1); // silence still divides safely
  });
});
