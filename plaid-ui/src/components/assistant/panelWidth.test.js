import { describe, it, expect } from 'vitest';
import {
  clampWidth,
  DOCK_MIN_WINDOW,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH,
  wideEnoughToDock,
} from './panelWidth.js';

describe('clampWidth', () => {
  it('keeps the panel between its bounds', () => {
    expect(clampWidth(400)).toBe(400);
    expect(clampWidth(10)).toBe(MIN_WIDTH);
    expect(clampWidth(5000)).toBe(MAX_WIDTH);
  });

  it('rounds, so a fractional pointer position does not make a fractional width', () => {
    expect(clampWidth(400.6)).toBe(401);
  });

  it('survives the nonsense a drag can produce', () => {
    // Math.max/min pass NaN through, and a NaN width paints nothing.
    expect(clampWidth(NaN)).toBe(DEFAULT_WIDTH);
    expect(clampWidth(undefined)).toBe(DEFAULT_WIDTH);
    expect(clampWidth(-1)).toBe(MIN_WIDTH);
  });
});

describe('wideEnoughToDock', () => {
  const at = (innerWidth) => {
    const was = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true });
    try {
      return wideEnoughToDock();
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: was, configurable: true });
    }
  };

  it('answers for the window as it is now', () => {
    expect(at(DOCK_MIN_WINDOW)).toBe(true);
    expect(at(DOCK_MIN_WINDOW + 400)).toBe(true);
    expect(at(DOCK_MIN_WINDOW - 1)).toBe(false);
    expect(at(800)).toBe(false);
  });

  it('is what every control that OPENS the dock asks', () => {
    // Ask sets a focus and the shell opens the panel on it. Where no panel can
    // show, pressing Ask does nothing at all, so it is not offered: the lit
    // island calls this directly, React calls it through useWideEnoughToDock.
    expect(at(800)).toBe(false);
  });
});
