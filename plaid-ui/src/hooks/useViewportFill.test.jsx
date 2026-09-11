import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { renderComponent } from '../test/renderComponent.jsx';
import { useViewportFill } from './useViewportFill.js';

// The docked panel is exactly as tall as what is left of the screen below the
// app's chrome, and that total is measured because the chrome is not one fixed
// thing. The measurement is viewport-relative, so it only means what it says
// while the page itself is at the top.

const VIEWPORT = 800;

// An element whose viewport top is `top`, and a page scrolled by `scrolled`.
function mountWith({ top, scrolled = 0 }) {
  const seen = { current: null };
  let scrollY = scrolled;
  window.scrollTo = vi.fn((x, y) => {
    scrollY = y;
  });
  const Probe = () => {
    const ref = useRef(null);
    seen.current = useViewportFill(ref, true, []);
    return (
      <div
        ref={(el) => {
          // `top` is where it sits with the page at the top.
          if (el) el.getBoundingClientRect = () => ({ top: top - scrollY });
          ref.current = el;
        }}
      />
    );
  };
  return renderComponent(<Probe />).then((r) => ({ ...r, height: () => seen.current }));
}

describe('useViewportFill', () => {
  beforeEach(() => {
    window.innerHeight = VIEWPORT;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills what is left of the viewport below the chrome', async () => {
    const { height, unmount } = await mountWith({ top: 177 });
    expect(height()).toBe(VIEWPORT - 177);
    await unmount();
  });

  it('is never taller than the screen when the page is scrolled', async () => {
    // Opening the panel from a sentence below the fold: the element's top is
    // above the viewport, so the naive measurement added the scroll offset and
    // the composer went off the bottom.
    const { height, unmount } = await mountWith({ top: 177, scrolled: 600 });
    expect(height()).toBeLessThanOrEqual(VIEWPORT);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(height()).toBe(VIEWPORT - 177);
    await unmount();
  });

  it('returns null when it is switched off', async () => {
    const seen = { current: 'unset' };
    const Probe = () => {
      const ref = useRef(null);
      seen.current = useViewportFill(ref, false, []);
      return <div ref={ref} />;
    };
    const { unmount } = await renderComponent(<Probe />);
    expect(seen.current).toBeNull();
    await unmount();
  });
});
