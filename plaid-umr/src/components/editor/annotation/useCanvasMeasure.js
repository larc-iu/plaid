import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Where the word columns are and how big each node box is, read off the DOM
// after a render, relative to the graph's own origin (so neither scrolling
// nor the stage's padding changes a measurement). The layout needs both, and both come from text the browser
// has to set first, so a block renders twice: once at estimated positions to
// measure, once placed. The measured values are kept in state and only
// replaced when they change, so the second render is the last.
const sameMap = (a, b, keys) => {
  if (a.size !== b.size) return false;
  for (const [id, v] of a) {
    const w = b.get(id);
    if (!w) return false;
    for (const k of keys) if (Math.abs(v[k] - w[k]) > 0.5) return false;
  }
  return true;
};

export const useCanvasMeasure = (measureKey) => {
  const canvasRef = useRef(null);
  const wordRefs = useRef(new Map());
  const nodeRefs = useRef(new Map());
  const [columns, setColumns] = useState(() => new Map());
  const [sizes, setSizes] = useState(() => new Map());

  const wordRef = useCallback(
    (id) => (el) => {
      if (el) wordRefs.current.set(id, el);
      else wordRefs.current.delete(id);
    },
    [],
  );
  const nodeRef = useCallback(
    (id) => (el) => {
      if (el) nodeRefs.current.set(id, el);
      else nodeRefs.current.delete(id);
    },
    [],
  );

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const origin = canvas.getBoundingClientRect();
    const nextColumns = new Map();
    wordRefs.current.forEach((el, id) => {
      const r = el.getBoundingClientRect();
      nextColumns.set(id, {
        x: r.left + r.width / 2 - origin.left,
        left: r.left - origin.left,
        right: r.right - origin.left,
      });
    });
    const nextSizes = new Map();
    nodeRefs.current.forEach((el, id) => {
      nextSizes.set(id, { width: el.offsetWidth, height: el.offsetHeight });
    });
    setColumns((prev) => (sameMap(prev, nextColumns, ['x', 'left', 'right']) ? prev : nextColumns));
    setSizes((prev) => (sameMap(prev, nextSizes, ['width', 'height']) ? prev : nextSizes));
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, measureKey]);

  // Fonts loading or the container resizing move the columns. The words are
  // siblings of the graph, so it is their common parent, the stage (sized by
  // its content), that is watched.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(canvas.parentElement || canvas);
    return () => observer.disconnect();
  }, [measure]);

  return { canvasRef, wordRef, nodeRef, nodeRefs, columns, sizes, remeasure: measure };
};
