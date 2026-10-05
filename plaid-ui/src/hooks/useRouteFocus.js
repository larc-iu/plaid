import { useEffect, useRef } from 'react';

// Where focus goes when the page changes.
//
// A single-page app swaps the page without the browser's own page load, so a
// link that is gone takes focus to the body, and a screen reader says nothing
// about the new page. On a new path, focus goes to the page's main heading,
// once it is drawn, unless something on the new page already took focus (a
// text box opened for typing, a settings menu that stayed). Only the path
// counts: a tab or a filter kept in the query string is the same page.

const WAIT_MS = 3000;

/** The page's main heading, or the main region itself when it has none. */
const mainTarget = (main) => main?.querySelector('h1') ?? null;

/** Focus `el` without scrolling it to the top edge and without a ring. */
const focusQuietly = (el) => {
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
};

/** Focus the main heading (or the main region) now. The skip link's action. */
export function focusMain(main) {
  if (!main) return;
  focusQuietly(mainTarget(main) ?? main);
}

/** Whether focus is somewhere the new page put it, which is left alone. */
const placed = (main) => {
  const at = document.activeElement;
  return !!at && at !== document.body && at.isConnected && main.contains(at);
};

export function useRouteFocus(pathname, mainRef) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    const main = mainRef.current;
    if (!main) return undefined;
    let done = false;
    let observer = null;
    let timer = null;
    const stop = () => {
      done = true;
      observer?.disconnect();
      clearTimeout(timer);
    };
    let start = null;
    const attempt = () => {
      if (done) return;
      if (placed(main)) return stop();
      // The reader moved on (into the header, say) while the page loaded.
      const at = document.activeElement;
      if (at && at !== start && at !== document.body) return stop();
      const heading = mainTarget(main);
      if (!heading) return;
      stop();
      focusQuietly(heading);
    };
    // After this render's own effects (a field's autoFocus) have run.
    const frame = requestAnimationFrame(() => {
      start = document.activeElement;
      attempt();
      if (done) return;
      observer = new MutationObserver(attempt);
      observer.observe(main, { childList: true, subtree: true });
      timer = setTimeout(stop, WAIT_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [pathname, mainRef]);
}
