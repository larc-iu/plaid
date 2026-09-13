import { useCallback, useEffect, useState } from 'react';
import { readWidth, saveWidth, wideEnoughToDock } from './panelWidth.js';

// How much room the assistant dock is taking, and whether the window has room
// for it at all. The shell pads by the width it reports (see AssistantDock.jsx
// for why the panel is fixed rather than a flex sibling).
//
// Every control that OPENS the dock asks this too, including the "Ask" beside a
// sentence and beside an entry: Ask sets a focus and the shell opens the panel
// on it, so in a window with no room for a panel Ask does nothing at all.

export const useWideEnoughToDock = () => {
  const [wide, setWide] = useState(wideEnoughToDock);
  useEffect(() => {
    const read = () => setWide(wideEnoughToDock());
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
