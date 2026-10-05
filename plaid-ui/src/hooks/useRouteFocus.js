import { useEffect, useRef } from 'react';
import { lastFocusedElement } from '../lib/focusReturn.js';

// Where focus goes when the page changes.
//
// A single-page app swaps the page without the browser's own page load, so a
// link that is gone takes focus to the body, and a screen reader says nothing
// about the new page. On a new path, focus goes to the page's main heading,
// once it is drawn, unless something on the new page already took focus (a
// text box opened for typing, a settings menu that stayed). Only the path
// counts: a tab or a filter kept in the query string is the same page.
//
// Where a tab strip is a set of paths (ud and umr), every tab is a new page
// that draws its own strip, so the tab that had focus is gone. Focus then goes
// to the new page's selected tab, and the arrows go on walking the strip.
//
// A slow page is waited for, and focus that the old page held and lost on the
// way counts as lost. A click or a key from the reader ends the wait.

const WAIT_MS = 10000;

/** The selected tab of the page's tab strip. */
const selectedTab = (main) =>
  main?.querySelector('[role=tablist] [role=tab][aria-selected=true]') ?? null;

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
  // The path last seen, not a first-render flag: StrictMode runs a mount's
  // effect twice, and a flag would take the second run for a new page.
  const seen = useRef(pathname);
  useEffect(() => {
    if (seen.current === pathname) return undefined;
    seen.current = pathname;
    const main = mainRef.current;
    if (!main) return undefined;
    // A tab of a strip that this change took away had focus.
    const was = lastFocusedElement();
    const fromTab = !!was && !was.isConnected && was.getAttribute?.('role') === 'tab';
    let done = false;
    let observer = null;
    let timer = null;
    const doc = main.ownerDocument;
    const stop = () => {
      done = true;
      observer?.disconnect();
      clearTimeout(timer);
      doc.removeEventListener('pointerdown', stop, true);
      doc.removeEventListener('keydown', stop, true);
    };
    let start = null;
    const attempt = (last = false) => {
      if (done) return;
      // The new page put focus somewhere: wait, in case the old page's element
      // it really was goes away.
      if (placed(main)) return;
      // The reader moved on (into the header, say) while the page loaded.
      const at = document.activeElement;
      if (at && at !== start && at !== document.body) return stop();
      let target = fromTab ? selectedTab(main) : null;
      if (!target && (!fromTab || last)) target = mainTarget(main);
      if (!target) return;
      stop();
      focusQuietly(target);
    };
    // After this render's own effects (a field's autoFocus) have run.
    const frame = requestAnimationFrame(() => {
      start = document.activeElement;
      attempt();
      if (done) return;
      observer = new MutationObserver(() => attempt());
      observer.observe(main, { childList: true, subtree: true });
      doc.addEventListener('pointerdown', stop, true);
      doc.addEventListener('keydown', stop, true);
      timer = setTimeout(() => {
        attempt(true);
        stop();
      }, WAIT_MS);
    });
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [pathname, mainRef]);
}
