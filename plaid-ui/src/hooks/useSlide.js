import { useEffect, useState } from 'react';

// How long a side panel takes to slide in or out, and the page with it. The
// History drawer and the assistant dock share it, so the two edges of a screen
// move alike. `SLIDE_CLASSES` is the matching Tailwind transition, written out
// whole so the class scanner finds it.
export const SLIDE_MS = 200;
export const SLIDE_CLASSES = 'duration-200 ease-out motion-reduce:transition-none';

const frame = (f) =>
  window.requestAnimationFrame ? window.requestAnimationFrame(f) : window.setTimeout(f, 16);
const cancelFrame = (id) =>
  window.cancelAnimationFrame ? window.cancelAnimationFrame(id) : window.clearTimeout(id);

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * A side panel that slides: `mounted` is whether to render it at all, and
 * `entered` whether it sits in its open place (translated in) or its closed
 * one (translated out of the window). Opening mounts it out of place and moves
 * it in on the next frame, so the transition runs. Closing moves it out and
 * unmounts it once the slide is done. With reduced motion there is no slide.
 */
export const useSlide = (open) => {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (reducedMotion()) {
        setEntered(true);
        return undefined;
      }
      // Two frames: the first paints the panel out of place, the second
      // moves it, which is what the transition animates.
      let second = 0;
      const first = frame(() => {
        second = frame(() => setEntered(true));
      });
      return () => {
        cancelFrame(first);
        cancelFrame(second);
      };
    }
    setEntered(false);
    if (reducedMotion()) {
      setMounted(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setMounted(false), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return { mounted: mounted || open, entered: entered && open };
};
