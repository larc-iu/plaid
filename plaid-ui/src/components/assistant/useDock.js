import { useCallback, useEffect, useState } from 'react';
import { readWidth, saveWidth } from './panelWidth.js';

// How much room the assistant dock is taking, and whether the window has room
// for it at all. The shell pads by the width it reports (see AssistantDock.jsx
// for why the panel is fixed rather than a flex sibling).

// Below this the window is too narrow to give a side panel any width and leave
// the annotation readable, so the panel is not offered at all. Matches
// Tailwind's `lg`, which is where the app's own screens stop being wide.
export const DOCK_MIN_WINDOW = 1024;

export const useWideEnoughToDock = () => {
  const [wide, setWide] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= DOCK_MIN_WINDOW,
  );
  useEffect(() => {
    const read = () => setWide(window.innerWidth >= DOCK_MIN_WINDOW);
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return wide;
};

// How wide the dock would be, and whether the window has room for it at all.
// Whether it is actually shown is `assistantGate`'s answer, not this one: it
// also depends on the project in scope having an assistant online.
export const useDockWidth = () => {
  const wide = useWideEnoughToDock();
  const [width, setWidth] = useState(readWidth);
  const resize = useCallback((w) => {
    setWidth(w);
    saveWidth(w);
  }, []);
  return { width, resize, wide };
};
