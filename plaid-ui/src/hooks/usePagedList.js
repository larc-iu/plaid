import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listPrefKey, useStickyState } from './useStickyState.js';

// Rows per page. There are two sizes and no others: a call site picks one of
// these rather than inventing a number, so that lists of a kind page alike.
//
// LIST_PAGE_SIZE is for a table whose rows are one line: a project, a
// document, a user. A hundred of those is a few screens of scrolling and the
// pager is rarely needed at all.
//
// TALL_LIST_PAGE_SIZE is for rows that carry several lines each: a sentence
// that wraps, a change list under it, a compose code with its description. A
// hundred of those is a page nobody can find the end of. It is the size the
// interlinear editor already pages sentences at (IgtEditor.PAGE_SIZE), so a
// screenful of sentences is a screenful of sentences wherever you meet one.
export const LIST_PAGE_SIZE = 100;
export const TALL_LIST_PAGE_SIZE = 25;

// The paging math, as a pure function: `page` is clamped into range, so a list
// that shrinks under the reader (a delete, a narrowed search) falls back onto
// its last page instead of rendering empty. The returned shape is exactly what
// <ListPager> wants, so a caller can spread it.
//
// Split out from the hook because the tagset editor pages a list it computes
// inside a .map() over tagsets, where a hook cannot be called.
export const pageSlice = (items, page, pageSize = LIST_PAGE_SIZE) => {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  return {
    pageItems: items.slice(current * pageSize, (current + 1) * pageSize),
    page: current,
    pageCount,
    total,
    rangeStart: total === 0 ? 0 : current * pageSize + 1,
    rangeEnd: Math.min((current + 1) * pageSize, total),
  };
};

/** The storage key for a list's remembered page, or null to not remember one. */
export const pageKey = (list, id) => listPrefKey('page', list, id);

const isPage = (v) => Number.isInteger(v) && v >= 0;

// Turn the page back to the first when `resetKey` changes, and only then. It
// compares against the last value rather than skipping the first effect run:
// StrictMode mounts, unmounts and mounts again on the same refs, so a run-once
// guard would let that second mount clear a page restored from storage. The
// skipped mount run was a no-op before this anyway, since the page starts at 0.
export const useResetOnChange = (resetKey, reset) => {
  const last = useRef(resetKey);
  useEffect(() => {
    if (last.current === resetKey) return;
    last.current = resetKey;
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
};

/** A `?page=` value as the reader writes it: 1-based, so `?page=2` is page 2. */
const fromParam = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
};

// Paging state for a client-side list. `resetKey` is whatever re-scopes the
// result set (the search text, the sort): when it changes the reader is looking
// at a different list, so page 1 is where they mean to be. Keep it a primitive,
// since it is an effect dependency. `storageKey` (from `pageKey`) remembers the
// page across visits; without one the paging is per-mount as before.
//
// `urlParam` puts the page in the query string as well, and from then on the
// URL is what the list shows: page 1 is never written (the way `?tab=` leaves
// its default off), so a bare list URL is page 1. The one exception is the
// list's first render under a `storageKey`: a bare URL then opens the
// remembered page, so a return visit lands where that reader left, and the
// URL is corrected to say so in place (a replace, so Back does not return to
// a bare entry that would now mean page 1). A link carries the page its
// sender was on either way.
//
// Turning a page is a push, so Back undoes it. `setPage(n, { replace: true })`
// is for a turn the reader did not ask for as such (a deep link to a row on
// another page, a reset by a new search), which must not leave an entry of its
// own for Back to stop at. Turning to the page already in the URL writes
// nothing, so it pushes no duplicate entry either.
//
// Without this a bare project URL opened EWT's documents on page 12 of 12 with
// nothing in the address saying so, and the link a colleague received showed
// them a different page of the same list. The selected lexicon entry sitting
// beside it has been in the URL (`?item=`) all along. And with the remembered
// page as the fallback for EVERY bare URL, Back from `?page=2` to the bare
// entry showed page 2 again.
export const usePagedList = (
  items,
  { pageSize = LIST_PAGE_SIZE, resetKey, storageKey, urlParam } = {},
) => {
  const [remembered, setRemembered] = useStickyState(storageKey ?? null, 0, isPage);
  const [params, setParams] = useSearchParams();
  const inUrl = urlParam ? fromParam(params.get(urlParam)) : null;
  // The key the remembered page has been restored under, once it has: until
  // then a bare URL means the remembered page, after it page 1.
  const [restoredFor, setRestoredFor] = useState(undefined);
  const restoring = !!urlParam && restoredFor !== storageKey;
  // A page written to the URL and not in it yet. The router can take the new
  // location a render later than this hook's own state, and a list that read
  // the old URL meanwhile showed page 1 for that render: long enough for a
  // deep link to look for its row there, not find it, and give up. It counts
  // only while the URL is still the one it was written over: a write of
  // another param in the same moment, from the query as it was before (the
  // igt project page dropping an unknown `?tab=`), can land last and take the
  // page off, and then the URL is what the list shows, not a page it no
  // longer names.
  const search = params.toString();
  const [heading, setHeading] = useState(null);
  const headed =
    heading && heading.key === storageKey && heading.from === search ? heading.page : null;
  let page = remembered;
  if (urlParam) page = headed ?? inUrl ?? (restoring ? remembered : 0);

  // The page into the URL. The URL is the truth, and the remembered page
  // follows what it shows (the effect below).
  const write = useCallback(
    (next, { replace = false } = {}) => {
      setHeading({ key: storageKey, page: next, from: search });
      setParams(
        (prev) => {
          // Copy so the rest of the query (`?tab=`, `?item=`) survives.
          const out = new URLSearchParams(prev);
          if (next <= 0) out.delete(urlParam);
          else out.set(urlParam, String(next + 1));
          return out;
        },
        { replace },
      );
    },
    [setParams, urlParam, storageKey, search],
  );

  // Arrived, or overtaken.
  useEffect(() => {
    if (heading && (headed == null || (inUrl ?? 0) === headed)) setHeading(null);
  }, [heading, headed, inUrl]);

  // The first render under this key: a bare URL showing the remembered page
  // is made to say so, in place. Asked once per key: StrictMode runs an effect
  // twice from the same render, and the second run wrote the remembered page
  // back over a deep link's.
  const restoreAsked = useRef(undefined);
  useEffect(() => {
    if (!restoring) return;
    setRestoredFor(storageKey);
    if (inUrl != null || remembered <= 0 || restoreAsked.current === storageKey) return;
    restoreAsked.current = storageKey;
    write(remembered, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoring, storageKey]);

  // What the URL shows is where this reader left the list, including where
  // Back and Forward took them. Only a change is stored: a default nobody
  // chose is not (useStickyState).
  useEffect(() => {
    if (urlParam && !restoring && page !== remembered) setRemembered(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, restoring]);

  // A turn asked for in the same mount as the restore (a deep link's) wins
  // over it: it is written after it. Otherwise a turn to the page already
  // shown writes nothing, since a same-URL navigate pushes a no-op entry.
  const setPage = useCallback(
    (next, opts) => {
      if (!urlParam) {
        setRemembered(next);
        return;
      }
      if (!restoring && next === page) return;
      write(next, opts);
    },
    [setRemembered, write, urlParam, restoring, page],
  );

  useResetOnChange(resetKey, () => setPage(0, { replace: true }));

  const slice = useMemo(() => pageSlice(items, page, pageSize), [items, page, pageSize]);
  return { ...slice, setPage };
};
