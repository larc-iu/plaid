import { useLayoutEffect, useState } from 'react';

// The height that makes an element reach the bottom of the viewport from
// wherever it happens to start.
//
// A docked side panel wants to be exactly as tall as the screen, and the
// chrome above it is not one fixed thing: an app header, breadcrumbs, a tab
// strip, and a run banner that comes and goes. Guessing that total in CSS
// gets it wrong the moment any of them changes, so it is measured.
//
// `active` switches it off (returning null) for the layouts that should keep
// the page's own scrolling. `deps` re-measures when the caller knows the
// chrome changed.
export const useViewportFill = (ref, active, deps = []) => {
  const [height, setHeight] = useState(null);

  useLayoutEffect(() => {
    if (!active) {
      setHeight(null);
      return undefined;
    }
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      let top = el.getBoundingClientRect().top;
      // `top` is viewport-relative, so it goes NEGATIVE when the page is
      // scrolled past the element. Filling "the rest of the viewport" from
      // there makes the element taller than the screen by the scroll offset:
      // the page still scrolls by that much, and the panel's header and its
      // composer can never both be on screen. Opening the panel on a sentence
      // below the fold did exactly that.
      //
      // The docked layout assumes the page itself is not scrolled, which is
      // also what it produces once it is applied, since the element then fits
      // exactly. So put the page back there and measure again.
      if (top < 0) {
        window.scrollTo(0, 0);
        top = el.getBoundingClientRect().top;
      }
      setHeight(Math.max(0, Math.round(window.innerHeight - Math.max(top, 0))));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active, ...deps]);

  return height;
};
