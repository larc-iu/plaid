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

// token -> what that call site would lose. A map rather than one slot, because
// a screen can hold two half-typed editors at once (UMR puts a text editor on
// each sentence) and the second to mount must not silence the first.
const drafts = new Map();

/** What is typed and unsaved right now, as a phrase, or null. */
export const hasUnsavedDraft = () => {
  for (const what of drafts.values()) return what;
  return null;
};

// Said yes to leaving: the drafts were the user's to lose, so all of them go.
const forget = () => drafts.clear();

// One question, wherever it is asked from. It states the fact.
const question = (what) => ({
  title: 'Leave without saving?',
  description: `${what} is not saved. Leaving loses it.`,
  confirmLabel: 'Leave',
  destructive: true,
});

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

// Take the extra entry out and WAIT for the traversal to land. A `go(-1)` left
// in flight while the router pushes the page the user just asked for would pop
// that page straight off again, so every caller that is about to navigate
// awaits this first. Resolves immediately when the entry is not ours or gone.
const dropStop = () =>
  new Promise((resolve) => {
    if (!installed || window.history.state?.[STOP] !== installed.token) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('popstate', done);
      resolve();
    };
    // A browser that never sends the event would otherwise hang the click.
    const timer = setTimeout(done, 1000);
    window.addEventListener('popstate', done);
    window.history.go(-1);
  });

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

  const onBeforeUnload = (e) => {
    if (!hasUnsavedDraft()) return;
    e.preventDefault();
    e.returnValue = '';
  };

  // Back landed on the page again, the extra entry spent. Ask, then either go
  // the rest of the way or put the entry back.
  const onPopState = () => {
    if (!hasUnsavedDraft()) return;
    Promise.resolve(state.ask()).then((ok) => {
      if (ok) window.history.go(-1);
      else arm();
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
      // The draft is forgotten by now, so this same listener waves the second
      // click through and the link does what it would have done.
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
 * with the drafts forgotten and the history entry taken back out. Hand it to
 * `Tabs` as `guard`, or await it before a navigation of your own.
 */
export const useUnsavedGuard = () => {
  const confirm = useConfirm();
  return useCallback(async () => {
    const what = hasUnsavedDraft();
    if (!what) return true;
    const ok = await confirm(question(what));
    if (!ok) return false;
    forget();
    await dropStop();
    return true;
  }, [confirm]);
};

/**
 * Register a half-typed value, so that leaving asks first. `what` names it in
 * the question ("The baseline text you have typed"); null while there is
 * nothing to lose.
 */
export const useUnsavedDraft = (what) => {
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
    drafts.set(token, what);
    install(() => guardRef.current());
    return () => {
      drafts.delete(token);
      uninstall();
    };
  }, [what, token]);
};
