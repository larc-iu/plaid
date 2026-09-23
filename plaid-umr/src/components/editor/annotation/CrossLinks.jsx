import { useEffect, useState } from 'react';
import { docTagsOf } from '../../../domain/sentenceGraph.js';
import { LINE_FAMILIES, lineFamily } from './docLines.js';
import { stableKey } from '@ui/domain/pendingIds.js';

// The active node's document relations that reach ANOTHER sentence, drawn
// across the blocks between them. A block draws what stays inside it; this
// is the one layer that spans blocks, so it lives on the canvas list.
//
// Same rule as inside a block: nothing at rest, since both ends wear the
// relation as a tag, and for the hovered or focused node a line from source
// to target with its head at the target, and a ring round the node at the
// other end so it can be found once scrolled to. A node on another page is
// not in the DOM and gets no line: its tag names it.
//
// Placed FIRST in the list and never given a z-index, so every positioned
// thing in the blocks after it (nodes, the margin's constants, the edges)
// paints over it: a line crossing a sentence in between runs behind that
// sentence's nodes instead of through their text.
export function CrossLinks({ listRef, graph, activeId, version }) {
  const [drawn, setDrawn] = useState(null);

  useEffect(() => {
    const list = listRef.current;
    const node = activeId ? graph.nodesById.get(activeId) : null;
    const triples = node ? docTagsOf(node, graph.nodesById).filter((t) => t.cross) : [];
    if (!list || !triples.length) {
      setDrawn(null);
      return undefined;
    }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const box = list.getBoundingClientRect();
      const find = (id) => list.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
      // A node's box in the list's coordinates, and where a line meets it:
      // a quarter in from the right, since the middle of the top is where
      // its tree edge arrives and two heads there read as one. Held inside
      // the block's visible width, because a wide sentence scrolls sideways
      // and the line should end where the reader can see.
      //
      // Null for a node not laid out at all: a block in text mode hides its
      // canvas, and a hidden node measures as a zero box at the corner.
      const rectOf = (el) => {
        if (!el.getClientRects().length) return null;
        const r = el.getBoundingClientRect();
        const c = el.closest('.umr-canvas')?.getBoundingClientRect() || r;
        const at = r.left + r.width * 0.75;
        const mid = Math.min(Math.max(at, c.left + 8), c.right - 8);
        return {
          // Whether the node itself is in view, and so worth a ring.
          seen: at >= c.left && at <= c.right,
          x: mid - box.left,
          top: r.top - box.top,
          bottom: r.bottom - box.top,
          left: r.left - box.left,
          width: r.width,
          height: r.height,
        };
      };
      const links = [];
      const rings = new Map();
      triples.forEach((t) => {
        const a = find(t.source);
        const b = find(t.target);
        if (!a || !b) return;
        const ra = rectOf(a);
        const rb = rectOf(b);
        if (!ra || !rb) return;
        // Leave the source on the side facing the target and arrive on the
        // side facing the source.
        const up = rb.top < ra.top;
        const y1 = up ? ra.top : ra.bottom;
        const y2 = up ? rb.bottom : rb.top;
        const k = Math.min(220, Math.abs(y2 - y1) / 2);
        const s = up ? -1 : 1;
        links.push({
          id: t.id,
          family: lineFamily(t, graph.nodesById),
          path: `M ${ra.x} ${y1} C ${ra.x} ${y1 + s * k}, ${rb.x} ${y2 - s * k}, ${rb.x} ${y2}`,
        });
        const far = t.source === activeId ? rb : ra;
        if (far.seen) rings.set(t.otherId, far);
      });
      setDrawn({
        width: list.scrollWidth,
        height: list.scrollHeight,
        links,
        rings: [...rings.entries()],
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    schedule();
    // A block scrolled sideways moves its nodes, and a layout change slides
    // them over a short transition: both are measured again once settled.
    list.addEventListener('scroll', schedule, true);
    list.addEventListener('transitionend', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      list.removeEventListener('scroll', schedule, true);
      list.removeEventListener('transitionend', schedule, true);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [listRef, graph, activeId, version]);

  if (!drawn || !drawn.links.length) return null;
  return (
    <svg className="umr-cross-links" width={drawn.width} height={drawn.height} aria-hidden="true">
      <defs>
        {Object.entries(LINE_FAMILIES).map(([family, color]) => (
          <marker
            key={family}
            id={`umr-arrow-cross-${family}`}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
            markerUnits="strokeWidth"
          >
            <path d="M 0 1 L 7 4 L 0 7 z" fill={color} />
          </marker>
        ))}
      </defs>
      {drawn.rings.map(([id, r]) => (
        <rect
          key={stableKey(id)}
          className="umr-cross-ring"
          x={r.left - 4}
          y={r.top - 4}
          width={r.width + 8}
          height={r.height + 8}
          rx="9"
        />
      ))}
      {drawn.links.map((l) => (
        <path
          key={stableKey(l.id)}
          d={l.path}
          className="umr-cross-link"
          data-triple-id={l.id}
          data-family={l.family}
          markerEnd={`url(#umr-arrow-cross-${l.family})`}
        />
      ))}
    </svg>
  );
}
