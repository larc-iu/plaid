import { useCallback, useLayoutEffect, useRef } from 'react';

// How near the end, in pixels, still counts as reading the end.
const NEAR_END_PX = 40;

/**
 * Keep a scrolling box at its end as its content grows, only while the reader
 * is there: scrolled up to read something, the box stays put until they come
 * back down. Only the box scrolls, never the page around it.
 *
 * `deps` are what grows the content. Returns `{ ref, onScroll, toEnd }`: the
 * box's ref and scroll handler, and `toEnd()`, which takes the box to its end
 * and follows it again (a turn the reader just sent, another conversation).
 */
export function useFollowEnd(deps, { enabled = true } = {}) {
  const ref = useRef(null);
  const atEnd = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_END_PX;
  }, []);

  const toEnd = useCallback(() => {
    atEnd.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (enabled && el && atEnd.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { ref, onScroll, toEnd };
}
