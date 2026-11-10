import { describe, it, expect } from 'vitest';
import { edgeScrollStep } from './edgeScroll.js';

// A sentence box from x 100 to x 900.
describe('edgeScrollStep', () => {
  it('scrolls nowhere away from the edges', () => {
    expect(edgeScrollStep(500, 100, 900)).toBe(0);
    expect(edgeScrollStep(100 + 48, 100, 900)).toBe(0);
    expect(edgeScrollStep(900 - 48, 100, 900)).toBe(0);
  });

  it('scrolls right near the right edge, faster closer to it, and as fast past it', () => {
    expect(edgeScrollStep(860, 100, 900)).toBeGreaterThan(0);
    expect(edgeScrollStep(895, 100, 900)).toBeGreaterThan(edgeScrollStep(860, 100, 900));
    expect(edgeScrollStep(900, 100, 900)).toBe(16);
    expect(edgeScrollStep(1400, 100, 900)).toBe(16);
  });

  it('scrolls left near the left edge, and as fast past it', () => {
    expect(edgeScrollStep(140, 100, 900)).toBeLessThan(0);
    expect(edgeScrollStep(100, 100, 900)).toBe(-16);
    expect(edgeScrollStep(0, 100, 900)).toBe(-16);
  });
});
