import { useCallback, useEffect, useRef, useState } from 'react';
import { ask, attachJob, followable, jobFor, metaOf, readConv, readMeta } from './jobs.js';

// One open tab acts on a conversation at a time (Luke's ruling, 2026-10-09).
// Any other tab or device shows it read-only with Continue here.
//
// The service keeps the hold on the conversation's sidebar entry, `holder:
// {tab, at}`, by its own clock, and refuses an op from a tab that does not
// hold it while the hold is live (plaid_agent/core/ops.py). Here:
//
// - The tab's id: minted on load and kept in sessionStorage, so a reload keeps
//   it and keeps the hold. A duplicated tab copies sessionStorage, so each tab
//   holds a Web Lock named for its id for its whole life, and a tab that finds
//   its id's lock taken mints another.
// - The ids this browser minted, in localStorage, so a hold by a closed tab of
//   this browser (its id listed, its lock free) counts as free at once.
// - A BroadcastChannel between tabs of this browser: a tab that takes a
//   conversation says so, and the others turn read-only at once.
// - While a conversation is on screen and the tab visible, its entry is read
//   every 15 s and on focus, for other devices. The holding tab renews the
//   hold every 2 minutes while visible.

// The service's lease (ops.LEASE_S).
export const LEASE_MS = 5 * 60 * 1000;
const RENEW_EVERY_MS = 2 * 60 * 1000;
const CHECK_EVERY_MS = 15 * 1000;
// How long a holder's lock stays free before its tab counts as closed: a tab
// that reloads lets its lock go and takes it again, under the same id.
const CLOSED_FOR_MS = 5 * 1000;

const TAB_KEY = 'plaid-assistant-tab';
const TABS_KEY = 'plaid-assistant-tabs';
const TABS_KEPT = 50;
const LOCK_PREFIX = 'plaid-assistant-tab:';
const CHANNEL = 'plaid-assistant';

const storage = (kind) => {
  try {
    return typeof window !== 'undefined' ? window[kind] : null;
  } catch {
    return null;
  }
};

const read = (kind, key) => {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const write = (kind, key, value) => {
  try {
    storage(kind)?.setItem(key, value);
  } catch {
    // A private window or blocked storage: the lease decides.
  }
};

const minted = () => {
  try {
    const list = JSON.parse(read('localStorage', TABS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

const remember = (id) => {
  const list = minted().filter((t) => t !== id);
  write('localStorage', TABS_KEY, JSON.stringify([...list, id].slice(-TABS_KEPT)));
};

const mint = () => {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  write('sessionStorage', TAB_KEY, id);
  remember(id);
  return id;
};

const locks = () => (typeof navigator !== 'undefined' ? navigator.locks : null) || null;

const channel = () => {
  try {
    return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
};

// The tab's id, and a promise that settles once its lock is held.
const state = (globalThis.__plaidAssistantTab ??= (() => {
  const s = { id: read('sessionStorage', TAB_KEY) || null, ready: null };
  if (!s.id) s.id = mint();
  else remember(s.id);
  const hold = (id) =>
    new Promise((resolve) => {
      const l = locks();
      if (!l) return resolve(id);
      l.request(`${LOCK_PREFIX}${id}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          // A duplicated tab: its copy of sessionStorage names a live tab.
          resolve(null);
          return undefined;
        }
        resolve(id);
        // Held for as long as the tab lives.
        return new Promise(() => {});
      }).catch(() => resolve(id));
      return undefined;
    });
  // A tab going away tells the others of this browser, which look again
  // whether it closed (its lock frees) rather than waiting for their next check.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      const c = channel();
      if (!c) return;
      try {
        c.postMessage({ left: s.id });
      } finally {
        c.close();
      }
    });
  }
  s.ready = (async () => {
    let got = await hold(s.id);
    while (!got) {
      s.id = mint();
      got = await hold(s.id);
    }
    return s.id;
  })();
  return s;
})());

// Whether `tab` is a tab of this browser that has closed: its id was minted
// here and its lock is free. Unknown (no Web Locks, storage empty) is false,
// and then the lease decides.
export const closedHere = async (tab) => {
  const l = locks();
  if (!tab || !l?.query || !minted().includes(tab)) return false;
  try {
    const { held = [] } = await l.query();
    return !held.some((h) => h.name === `${LOCK_PREFIX}${tab}`);
  } catch {
    return false;
  }
};

// Whether a hold is live for a tab other than `tab` at `now` (ms, the server's
// clock): someone else holds it and their lease has not run out.
export const heldElsewhere = (holder, tab, now) => {
  if (!holder?.tab || holder.tab === tab) return false;
  const at = Date.parse(holder.at || '');
  return Number.isFinite(at) && now - at <= LEASE_MS;
};

// The holder to go by: the entry's, or a take another tab of this browser
// announced (`takenBy`, {conv, tab, at}, `at` when it was heard, the server's
// clock) before the entry says so. Once the entry names that tab, or holds
// newer news, the entry decides, so a hold taken with Continue here lapses
// like any other when its tab stops renewing.
export const shownHolder = (takenBy, convId, holder) => {
  if (!takenBy || takenBy.conv !== convId) return holder ?? null;
  const said = Date.parse(holder?.at || '');
  if (holder?.tab === takenBy.tab || (Number.isFinite(said) && said >= takenBy.at)) return holder;
  return { tab: takenBy.tab, at: new Date(takenBy.at).toISOString() };
};

// Say to the other tabs of this browser that this one took a conversation.
export const announce = (conv) => {
  const c = channel();
  if (!c) return;
  try {
    c.postMessage({ conv, tab: state.id });
  } finally {
    c.close();
  }
};

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

// The hold on the open conversation, for the chat. `meta` is its sidebar
// entry as the list has it, `applyMeta` puts a newer one there, `onChanged`
// is told when the record changed underneath (reread it), `onGone` when it
// was deleted. Answers `{readOnly, continueHere, taking}`.
//
// A tab takes a free conversation when it opens it (Luke's ruling, 2026-10-09),
// and never one another tab holds without Continue here.
export const useHold = ({
  store,
  service,
  convId,
  saved,
  meta,
  applyMeta,
  onChanged,
  onGone,
  docked = false,
}) => {
  const [tab, setTab] = useState(state.id);
  const [now, setNow] = useState(() => serverNow(store.client));
  // A holder found closed here, {tab, since, sure}: its lock free since then,
  // and `sure` once that has lasted CLOSED_FOR_MS.
  const [closed, setClosed] = useState(null);
  const [taking, setTaking] = useState(false);
  // A take announced by another tab of this browser, before the entry says so.
  const [takenBy, setTakenBy] = useState(null);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const cbs = useRef({ applyMeta, onChanged, onGone });
  cbs.current = { applyMeta, onChanged, onGone };

  useEffect(() => {
    let live = true;
    state.ready.then((id) => live && setTab(id));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => setTakenBy(null), [convId]);

  const holder = shownHolder(takenBy, convId, meta?.holder);
  const mine = !!holder?.tab && holder.tab === tab;
  // The holder is a closed tab of this browser: its lock has been free for a
  // while, longer than a reload takes.
  const holderTab = holder?.tab ?? null;
  const closedTab = !!holderTab && closed?.tab === holderTab && closed.sure;
  const elsewhere = !!service && saved && !!meta && heldElsewhere(holder, tab, now) && !closedTab;

  // Whether the holder is a closed tab of this browser, asked when it changes,
  // and again once it could have come back from a reload.
  useEffect(() => {
    let live = true;
    let again = null;
    if (!holderTab || holderTab === tab) return undefined;
    closedHere(holderTab).then((yes) => {
      if (!live) return;
      const at = Date.now();
      setClosed((was) => {
        if (!yes) return null;
        if (was?.tab !== holderTab) return { tab: holderTab, since: at, sure: false };
        return at - was.since >= CLOSED_FOR_MS && !was.sure ? { ...was, sure: true } : was;
      });
      if (yes) again = setTimeout(() => setNow(serverNow(store.client)), CLOSED_FOR_MS + 100);
    });
    return () => {
      live = false;
      clearTimeout(again);
    };
  }, [holderTab, tab, now, store]);

  const hold = useCallback(
    async (take = false) => {
      if (!service || !convId) return null;
      await state.ready;
      setTaking(true);
      try {
        const result = await ask(store, service, convId, 'hold', take ? { take: true } : {}, {
          tab: state.id,
        });
        const m = metaOf(store, result);
        if (m) cbs.current.applyMeta(m);
        if (result?.kind === 'refused' && result.why === 'gone') cbs.current.onGone?.();
        if (result?.kind === 'done') {
          setTakenBy(null);
          if (take) announce(convId);
        }
        return result;
      } catch (e) {
        console.warn('[Assistant] could not hold the conversation', e);
        return null;
      } finally {
        setTaking(false);
      }
    },
    [store, service, convId],
  );

  // Take a free conversation on open, and again whenever it falls free. A
  // hold by a closed tab of this browser is taken, since the service still
  // counts its lease.
  const free = !!service && saved && !!meta && !mine && !elsewhere;
  useEffect(() => {
    if (free && !taking) hold(closedTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [free, convId, closedTab]);

  // Renew while visible.
  useEffect(() => {
    if (!mine || !service) return undefined;
    const renew = () => visible() && hold(false);
    const timer = setInterval(renew, RENEW_EVERY_MS);
    const onVisible = () => visible() && renew();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [mine, service, hold]);

  // Look at the entry: every 15 s while visible, and on focus.
  useEffect(() => {
    if (!saved || !convId) return undefined;
    let live = true;
    const check = async () => {
      if (!visible()) return;
      setNow(serverNow(store.client));
      let fresh;
      try {
        fresh = await readMeta(store, convId);
      } catch {
        return;
      }
      if (!live) return;
      if (!fresh) {
        cbs.current.onGone?.();
        return;
      }
      const was = metaRef.current;
      cbs.current.applyMeta(fresh);
      if (!was || fresh.updatedAt !== was.updatedAt) cbs.current.onChanged?.();
      // Work the holder asked for is watched here live.
      if (followable(fresh.pending) && !jobFor(convId)) {
        readConv(store, convId)
          .then((read) => {
            if (live && !jobFor(convId) && followable(read.meta?.pending)) {
              attachJob({ store, conv: read.conv, meta: read.meta, docked, tab: state.id });
            }
          })
          .catch(() => {});
      }
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [store, convId, saved, docked]);

  // Another tab of this browser took a conversation.
  useEffect(() => {
    const c = channel();
    if (!c) return undefined;
    c.onmessage = (e) => {
      const { conv, tab: other, left } = e.data || {};
      if (conv && other && other !== state.id)
        setTakenBy({ conv, tab: other, at: serverNow(store.client) });
      setNow(serverNow(store.client));
      // A tab went away: look whether it closed once its lock is let go.
      if (left) setTimeout(() => setNow(serverNow(store.client)), 300);
    };
    return () => c.close();
  }, [store]);

  const continueHere = useCallback(() => hold(true), [hold]);

  return { tab, readOnly: elsewhere, continueHere, taking, hold };
};

const serverNow = (client) => {
  try {
    return client?.serverNow?.()?.getTime?.() ?? Date.now();
  } catch {
    return Date.now();
  }
};
