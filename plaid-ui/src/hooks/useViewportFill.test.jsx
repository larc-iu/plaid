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
  // The hook reads window.scrollY, so the fake page has to have one.
  const setScroll = (y) => {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
  };
  setScroll(scrolled);
  window.scrollTo = vi.fn((x, y) => setScroll(y));
  const Probe = () => {
    const ref = useRef(null);
    seen.current = useViewportFill(ref, true, []);
    return (
      <div
        ref={(el) => {
          // `top` is where it sits with the page at the top.
          if (el) el.getBoundingClientRect = () => ({ top: top - window.scrollY });
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

  it('is right for a PARTIAL scroll too, not only a full one', async () => {
    // Handling only "top has gone negative" left every partial scroll wrong:
    // chrome at 177 with the page down 100 measured 723, and once the layout
    // applied the browser clamped the scroll back to 0 and left the element
    // 100px taller than the screen.
    const { height, unmount } = await mountWith({ top: 177, scrolled: 100 });
    expect(height()).toBe(VIEWPORT - 177);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
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

  it('hands the discarded page scroll to the element that now scrolls', async () => {
    // Measuring puts the page at the top, and that offset is the reader's place
    // in the document. Thrown away, opening the panel from anywhere but the
    // first line dumped them back at the top of what they were reading.
    const seen = { current: null };
    Object.defineProperty(window, 'scrollY', { value: 300, configurable: true, writable: true });
    window.scrollTo = vi.fn((x, y) => {
      Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
    });
    const scroller = { scrollTop: 0, scrollHeight: 4000, clientHeight: 600 };
    const frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      frames.push(fn);
      return frames.length;
    });

    const Probe = () => {
      const ref = useRef(null);
      const scrollerRef = useRef(scroller);
      seen.current = useViewportFill(ref, true, [], scrollerRef);
      return (
        <div
          ref={(el) => {
            if (el) el.getBoundingClientRect = () => ({ top: 177 - window.scrollY });
            ref.current = el;
          }}
        />
      );
    };
    const { unmount } = await renderComponent(<Probe />);
    // The row starts 177 into the document, so 300 of page scroll is 123 into
    // the row itself.
    frames.forEach((fn) => fn());
    expect(scroller.scrollTop).toBe(123);
    expect(seen.current).toBe(VIEWPORT - 177);
    await unmount();
  });

  it('does not move the reader on a re-measure', async () => {
    // A resize or a chrome change re-measures with the page already at zero.
    // Re-applying the offset then would move them for no reason.
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    window.scrollTo = vi.fn();
    const scroller = { scrollTop: 40, scrollHeight: 4000, clientHeight: 600 };
    const frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      frames.push(fn);
      return frames.length;
    });
    const Probe = () => {
      const ref = useRef(null);
      const scrollerRef = useRef(scroller);
      useViewportFill(ref, true, [], scrollerRef);
      return (
        <div
          ref={(el) => {
            if (el) el.getBoundingClientRect = () => ({ top: 177 });
            ref.current = el;
          }}
        />
      );
    };
    const { unmount } = await renderComponent(<Probe />);
    frames.forEach((fn) => fn());
    expect(scroller.scrollTop).toBe(40); // untouched
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
