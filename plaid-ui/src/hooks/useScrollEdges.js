import { useCallback, useEffect, useState } from 'react';
import { NO_EDGES, hiddenEdges, sameEdges } from '../lib/scrollEdges.js';

/**
 * Which edges of the sideways-scrolling `ref` have content past them, kept up
 * to date as it scrolls and as it or its content changes size. Returns the
 * edges and an `onScroll` for the box.
 */
export function useScrollEdges(ref) {
  const [edges, setEdges] = useState(NO_EDGES);
  const measure = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    const next = hiddenEdges(box);
    setEdges((prev) => (sameEdges(prev, next) ? prev : next));
  }, [ref]);
  useEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const resized = new ResizeObserver(measure);
    resized.observe(box);
    if (box.firstElementChild) resized.observe(box.firstElementChild);
    return () => resized.disconnect();
  });
  return [edges, measure];
}
