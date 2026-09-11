import { describe, it, expect } from 'vitest';
import { clampWidth, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH } from './panelWidth.js';

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
