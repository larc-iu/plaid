import { useCallback, useEffect, useRef } from 'react';
import { useConfirm } from '../components/shared/ConfirmProvider.jsx';

// Text typed and not yet saved, and the one question asked before it is lost.
//
// A screen holding a half-typed value registers it with
// `useUnsavedDraft('The baseline text you have typed')`, and every way out of
// that screen then asks the same question before taking it:
//
//  - the tab strip, through `useUnsavedGuard()` handed to `Tabs` as `guard`;
//  - any in-app link (a breadcrumb, a document row, the project name), through
//    a capture-phase click listener installed while a draft exists;
//  - the browser's Back button, through one extra history entry standing in
//    front of the page while a draft exists, so the first Back lands here;
//  - a reload or a closed window, through `beforeunload`, which is the
//    browser's own question and the only one it will let us ask.
//
// Why not react-router's `useBlocker`: all three apps mount `HashRouter`, the
// component router, and `useBlocker` is a data-router hook that throws outside
// `RouterProvider`. Under HashRouter the whole route is the URL fragment, and
// that is what makes the extra history entry invisible: it carries the SAME
// url, so landing on it re-renders the page instead of navigating anywhere.

// token -> `{ what, several }`, the call site's names for what it would lose,
// one and many. A map rather than one slot, because a screen can hold two
// half-typed editors at once (UMR puts a text editor on each sentence) and the
// second to mount must not silence the first.
const drafts = new Map();

// An exit the reader has approved, on its way out right now. The answer covers
// that one exit, so nothing asks about it again as it goes: the click this
// module re-dispatches passes the click listener, and the traversal it starts
// does not come back through the Back question. It lasts exactly as long as
// the exit does. A draft is never dropped for it: what ends a draft is the
// screen holding it going away.
let leaving = 0;

/** What is typed and unsaved right now, as a phrase, or null. */
export const hasUnsavedDraft = () => {
  if (leaving) return null;
  for (const { what } of drafts.values()) return what;
  return null;
};

// How many are unsaved, and what they are. Leaving loses every one of them, so
// the question counts them rather than naming the first and taking all three.
// Two DIFFERENT things typed on one screen is not a shape any screen has
// today, since a tab holding one is unmounted when another is open, and naming
// what they have in common is honest about all of them either way.
const several = (drafted) => {
  const nouns = new Set(drafted.map((d) => d.several).filter(Boolean));
  return `${drafted.length} ${nouns.size === 1 ? [...nouns][0] : 'things you have typed'}`;
};

// One question, wherever it is asked from. It states the fact.
const question = () => {
  const drafted = [...drafts.values()];
  return {
    title: 'Leave without saving?',
    description:
      drafted.length === 1
        ? `${drafted[0].what} is not saved. Leaving loses it.`
        : `${several(drafted)} are not saved. Leaving loses them.`,
    confirmLabel: 'Leave',
    destructive: true,
  };
};

// ---------------------------------------------------------------------------
// The blocker: installed while any draft exists, torn down when the last goes.

// The mark on the extra history entry, read back off `history.state` so the
// entry is only ever taken out by the hook that put it in.
const STOP = '__plaidUnsavedDraftStop';

let installed = null;

const sameUrl = (a, b) => {
  const key = (u) => u.origin + u.pathname + u.search + (u.hash === '#' ? '' : u.hash);
  return key(a) === key(b);
};

// `history.go(n)`, resolved once the traversal has landed. A browser that
// never sends the event would otherwise hang whatever is waiting on it.
const traverse = (n) =>
  new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('popstate', done);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    window.addEventListener('popstate', done);
    window.history.go(n);
  });

// Take the extra entry out and WAIT for the traversal to land. A `go(-1)` left
// in flight while the router pushes the page the user just asked for would pop
// that page straight off again, so every caller that is about to navigate
// awaits this first. Resolves immediately when the entry is not ours or gone.
const dropStop = async () => {
  if (!installed || window.history.state?.[STOP] !== installed.token) return;
  await traverse(-1);
};

// The approved exit has had its turn. If the screen is still standing here
// with something typed on it, the question stands again, and Back needs the
// entry that was taken out of its way put back.
const settle = () => {
  if (leaving || !installed || !drafts.size) return;
  installed.arm();
};

const install = (ask) => {
  if (installed) {
    installed.ask = ask;
    return;
  }
  const state = { ask, token: `${Date.now()}.${Math.random()}` };
  installed = state;

  // One extra entry in front of this page, so Back has somewhere to land that
  // is not a navigation. Same URL, and the router's own `idx` carried forward
  // so the entries it counts stay in order.
  const arm = () => {
    const current = window.history.state;
    if (current && current[STOP]) return;
    const next = { ...current, [STOP]: state.token };
    if (typeof current?.idx === 'number') next.idx = current.idx + 1;
    window.history.pushState(next, '');
  };
  state.arm = arm;

  const onBeforeUnload = (e) => {
    if (!hasUnsavedDraft()) return;
    e.preventDefault();
    e.returnValue = '';
  };

  // Back landed on the page again, the extra entry spent. Ask, then either go
  // the rest of the way or put the entry back.
  const onPopState = () => {
    if (!hasUnsavedDraft()) return;
    Promise.resolve(state.ask()).then(async (ok) => {
      if (!ok) {
        arm();
        return;
      }
      // Back the rest of the way. The traversal sends a popstate of its own,
      // which is this same exit arriving and not a second Back to ask about.
      leaving += 1;
      try {
        await traverse(-1);
      } finally {
        leaving -= 1;
        settle();
      }
    });
  };

  // An in-app link, before React or the router sees the click. A modified
  // click opens a new browser tab and loses nothing; a tab trigger is asked
  // about by `Tabs`'s own guard on mousedown; a link off this origin is the
  // browser's question through `beforeunload`.
  const onClick = (e) => {
    if (!hasUnsavedDraft() || e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = e.target?.closest?.('a[href]');
    if (!anchor || anchor.getAttribute('role') === 'tab') return;
    if (anchor.hasAttribute('download')) return;
    const target = anchor.getAttribute('target');
    if (target && target !== '_self') return;
    let url;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    const here = new URL(window.location.href);
    if (url.origin !== here.origin || sameUrl(url, here)) return;
    // Nothing navigates behind the question: React never sees this click.
    e.preventDefault();
    e.stopPropagation();
    Promise.resolve(state.ask()).then((ok) => {
      if (!ok) return;
      // The answer covers this one click, so this same listener waves the
      // second one through and the link does what it would have done. The
      // draft itself stays registered: if the click turns out not to take the
      // page, the text is still on the screen and the next way out asks again.
      leaving += 1;
      try {
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } finally {
        leaving -= 1;
        settle();
      }
    });
  };

  arm();
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('popstate', onPopState);
  document.addEventListener('click', onClick, true);

  state.teardown = () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('popstate', onPopState);
    document.removeEventListener('click', onClick, true);
  };
};

const uninstall = () => {
  const gone = installed;
  if (!gone) return;
  // Deferred: a draft that comes straight back (a new phrase for the same
  // field, a remount) must not take the history entry out and put it in again.
  queueMicrotask(async () => {
    if (installed !== gone || drafts.size) return;
    await dropStop();
    if (installed !== gone || drafts.size) return;
    installed = null;
    gone.teardown();
  });
};

/**
 * Ask before leaving, if there is anything to lose. Resolves true to go ahead,
 * with the history entry taken back out. Hand it to `Tabs` as `guard`, or
 * await it before a navigation of your own.
 */
export const useUnsavedGuard = () => {
  const confirm = useConfirm();
  return useCallback(async () => {
    if (!hasUnsavedDraft()) return true;
    const ok = await confirm(question());
    if (!ok) return false;
    // The drafts are NOT forgotten here. The answer is about one way out, and
    // what ends a draft is the screen holding it going away: its own effect
    // takes it out of the map on the way. A caller that asks and then does not
    // leave (a navigation the app declines, a tab it refuses to change) leaves
    // the text where it was, and the next way out asks about it again.
    //
    // The exit starts here: taking the entry out is itself a traversal, and
    // the popstate it sends must not come back as the Back question. It ends a
    // macrotask later, which is after the navigation the caller makes when
    // this resolves and long before anyone can reach for Back. If the screen
    // is still standing there by then, the entry goes back in front of it.
    leaving += 1;
    await dropStop();
    setTimeout(() => {
      leaving -= 1;
      settle();
    }, 0);
    return true;
  }, [confirm]);
};

/**
 * Leave without asking, because what the drafts belonged to is gone: the
 * document holding them has just been deleted, so there is nothing left to
 * rename and nothing to ask about.
 *
 * The extra history entry still has to come out, and it has to come out BEFORE
 * the navigation: once the router has pushed the next page the entry is buried
 * under it, nothing can take it out again, and the reader pays for it with a
 * Back press that looks like it did nothing.
 */
export const dropUnsavedDrafts = async () => {
  drafts.clear();
  await dropStop();
};

/**
 * Register a half-typed value, so that leaving asks first.
 *
 * `what` names it in the question ("The baseline text you have typed"), and is
 * null while there is nothing to lose. `plural` names them in the plural
 * ("graphs"), for a screen that can hold several at once: the question counts
 * those rather than naming the first of them, because Leave loses all of them.
 */
export const useUnsavedDraft = (what, plural = null) => {
  const guard = useUnsavedGuard();
  // The blocker outlives any one render, so it asks through a box rather than
  // through the callback it happened to be installed with.
  const guardRef = useRef(guard);
  guardRef.current = guard;
  const tokenRef = useRef(null);
  if (!tokenRef.current) tokenRef.current = {};
  const token = tokenRef.current;

  useEffect(() => {
    if (!what) return undefined;
    drafts.set(token, { what, several: plural });
    install(() => guardRef.current());
    return () => {
      drafts.delete(token);
      uninstall();
    };
  }, [what, plural, token]);
};
