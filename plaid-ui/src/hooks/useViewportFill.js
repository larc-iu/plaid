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
      // `top` is viewport-relative, so ANY page scroll makes it smaller than
      // the chrome above the element and "the rest of the viewport" too tall
      // by that much. Once the layout applies, the page stops overflowing and
      // the browser clamps the scroll back to 0, leaving the element taller
      // than the screen: the page scrolls by the difference, and the panel's
      // header and its composer can never both be on screen.
      //
      // Handling only the extreme (top gone negative) left every partial
      // scroll wrong. The docked layout assumes the page is at the top, and
      // is what produces that state once applied, so put it there first and
      // measure what is actually left.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      const top = el.getBoundingClientRect().top;
      setHeight(Math.max(0, Math.round(window.innerHeight - Math.max(top, 0))));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active, ...deps]);

  return height;
};
