import { useSyncExternalStore } from 'react';

// Where the recording is, every frame, outside React.
//
// The position used to be React state set from a requestAnimationFrame loop,
// so the whole Media tab re-rendered sixty times a second while it played: the
// player, the timeline and every transcript row (over a thousand on a recording
// with speech detection run). Frames took a quarter of a second and the needle
// stuttered. Now the few things that move every frame (the needle, the seek
// bar) read this clock, and the tab's React state takes the position only a few
// times a second, which is all the rest of it shows.
export function createPlaybackClock() {
  let time = 0;
  const listeners = new Set();
  return {
    get: () => time,
    set(t) {
      if (!Number.isFinite(t) || t === time) return;
      time = t;
      for (const fn of listeners) fn(t);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The clock's time, re-rendering the caller on every change. */
export const useClockTime = (clock) => useSyncExternalStore(clock.subscribe, clock.get);
