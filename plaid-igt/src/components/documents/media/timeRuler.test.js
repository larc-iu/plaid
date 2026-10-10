import { describe, it, expect } from 'vitest';
import { rulerScale, rulerTicks, rulerLabel, LABEL_GAP_PX } from './timeRuler.js';
import { MIN_ZOOM, MAX_ZOOM } from './useTimelineOperations.js';

describe('the time ruler', () => {
  it('labels far enough apart at every zoom, from the whole recording to a millisecond a pixel', () => {
    for (let pps = MIN_ZOOM; pps <= MAX_ZOOM; pps *= 1.1) {
      const { major, minor } = rulerScale(pps);
      expect(major * pps).toBeGreaterThanOrEqual(LABEL_GAP_PX);
      // The next step down would have crowded them.
      expect(major * pps).toBeLessThan(LABEL_GAP_PX * 3.1);
      if (minor) expect(minor * pps).toBeGreaterThanOrEqual(6);
    }
  });

  it('steps by round numbers: tenths at a millisecond a pixel, seconds and minutes further out', () => {
    expect(rulerScale(1000)).toEqual({ major: 0.1, minor: 0.02, decimals: 1 });
    expect(rulerScale(22)).toEqual({ major: 5, minor: 1, decimals: 0 });
    expect(rulerScale(4)).toEqual({ major: 30, minor: 10, decimals: 0 });
    expect(rulerScale(0.05).major).toBe(1800);
  });

  it('labels every whole step and marks the steps between, counted from zero', () => {
    const ticks = rulerTicks(0, 10, 22);
    expect(ticks.filter((t) => t.major).map((t) => t.time)).toEqual([0, 5, 10]);
    expect(ticks).toHaveLength(11);
    // A stretch that starts mid-way starts at the next small tick.
    expect(rulerTicks(2.3, 3, 1000)[0]).toEqual({ time: 2.3, major: true });
    expect(rulerTicks(2.31, 2.4, 1000).map((t) => t.time)).toEqual([2.32, 2.34, 2.36, 2.38, 2.4]);
  });

  it('does not drift along a long recording', () => {
    const ticks = rulerTicks(3590, 3600, 1000);
    expect(ticks.at(-1)).toEqual({ time: 3600, major: true });
    expect(ticks.every((t) => Number.isInteger(Math.round(t.time * 50)))).toBe(true);
  });

  it('reads as the clock does, with hours once the recording needs them', () => {
    expect(rulerLabel(0)).toBe('0:00');
    expect(rulerLabel(65)).toBe('1:05');
    expect(rulerLabel(2.3, 1)).toBe('0:02.3');
    expect(rulerLabel(2.35, 2)).toBe('0:02.35');
    expect(rulerLabel(3725, 0)).toBe('1:02:05');
    expect(rulerLabel(65, 0, true)).toBe('0:01:05');
  });
});
