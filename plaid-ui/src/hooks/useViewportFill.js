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
//
// `scrollerRef` is the element that takes over the scrolling once the height is
// applied. Measuring has to put the page at the top (see below), and that
// throws away the reader's place in the document: without handing the offset
// over, opening the panel from anywhere but the top of a document dumped them
// back at its first line, which is most visible on IGT's "Ask", where the whole
// point is to talk about the sentence in front of you.
export const useViewportFill = (ref, active, deps = [], scrollerRef = null) => {
  const [height, setHeight] = useState(null);

  useLayoutEffect(() => {
    if (!active) {
      setHeight(null);
      return undefined;
    }
    let carry = null;
    const measure = (first = false) => {
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
      const page = window.scrollY;
      // Document-relative, so it has to be read BEFORE the page moves.
      const rowTop = el.getBoundingClientRect().top + page;
      if (page !== 0) window.scrollTo(0, 0);
      const top = el.getBoundingClientRect().top;
      setHeight(Math.max(0, Math.round(window.innerHeight - Math.max(top, 0))));
      // Only on the way in. A re-measure (the chrome changed, the window
      // resized) happens with the page already at the top, and re-applying a
      // stale offset then would move the reader for no reason.
      if (first && page > 0) carry = Math.max(0, Math.round(page - rowTop));
    };
    measure(true);
    if (carry !== null && scrollerRef) {
      // The container cannot scroll until the measured height is on it, which
      // is a render away, and it may take more than one frame to be scrollable.
      let frames = 0;
      const hand = () => {
        const scroller = scrollerRef.current;
        if (scroller && scroller.scrollHeight > scroller.clientHeight) {
          scroller.scrollTop = carry;
          return;
        }
        if (frames++ < 10) requestAnimationFrame(hand);
      };
      requestAnimationFrame(hand);
    }
    const onResize = () => measure(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, active, scrollerRef, ...deps]);

  return height;
};
