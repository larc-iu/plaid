import { describe, it, expect, afterEach } from 'vitest';
import { anchoredPos } from './shared.js';

// Where the grid's floating surfaces sit. All three (the popover, the row menu,
// the alternatives list) share this, so the edges are worth pinning: an edge
// column must not push one off screen, and a short window must not hide it.

const anchor = ({ left = 100, top = 100, width = 40, height = 20 }) => ({
  getBoundingClientRect: () => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }),
});

const viewport = (w, h) => {
  window.innerWidth = w;
  window.innerHeight = h;
};

afterEach(() => viewport(1024, 768));

describe('anchoredPos', () => {
  it('sits under its opener, left-aligned or centred', () => {
    viewport(1024, 768);
    expect(anchoredPos(anchor({ left: 100, top: 100 }), { width: 240, height: 80 })).toEqual({
      left: 100,
      top: 124,
    });
    expect(
      anchoredPos(anchor({ left: 500, top: 100 }), { width: 240, height: 80, center: true }),
    ).toEqual({ left: 400, top: 124 });
  });

  it('flips above when there is no room below', () => {
    viewport(1024, 300);
    expect(anchoredPos(anchor({ left: 100, top: 200 }), { width: 240, height: 80 })).toEqual({
      left: 100,
      top: 116,
    });
  });

  it('stays on screen when neither side has the room', () => {
    viewport(1024, 120);
    const { top } = anchoredPos(anchor({ left: 100, top: 40 }), { width: 240, height: 100 });
    // As far up as it can go while keeping its bottom edge off the fold.
    expect(top).toBe(12);
  });

  it('keeps an edge column s surface inside the viewport', () => {
    viewport(400, 768);
    const { left } = anchoredPos(anchor({ left: 380, top: 100 }), { width: 240, height: 80 });
    expect(left).toBe(400 - 240 - 8);
  });

  it('is nothing at all without an opener', () => {
    expect(anchoredPos(null, { width: 240, height: 80 })).toBeNull();
  });
});
