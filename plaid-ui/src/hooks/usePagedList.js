import { useCallback, useEffect, useMemo, useRef } from 'react';
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
// `urlParam` puts the page in the query string as well. The URL WINS where it
// says a page, and the remembered one is what a bare list URL falls back on, so
// a link carries the page its sender was on while a return visit still lands
// where that reader left. Page 1 is never written, the way `?tab=` leaves its
// default off. Turning a page is a push, so Back undoes it.
//
// Without this a bare project URL opened EWT's documents on page 12 of 12 with
// nothing in the address saying so, and the link a colleague received showed
// them a different page of the same list. The selected lexicon entry sitting
// beside it has been in the URL (`?item=`) all along.
export const usePagedList = (
  items,
  { pageSize = LIST_PAGE_SIZE, resetKey, storageKey, urlParam } = {},
) => {
  const [remembered, setRemembered] = useStickyState(storageKey ?? null, 0, isPage);
  const [params, setParams] = useSearchParams();
  const inUrl = urlParam ? fromParam(params.get(urlParam)) : null;
  const page = inUrl ?? remembered;

  const setPage = useCallback(
    (next) => {
      setRemembered(next);
      if (!urlParam) return;
      setParams((prev) => {
        // Copy so the rest of the query (`?tab=`, `?item=`) survives.
        const out = new URLSearchParams(prev);
        if (next <= 0) out.delete(urlParam);
        else out.set(urlParam, String(next + 1));
        return out;
      });
    },
    [setRemembered, setParams, urlParam],
  );

  useResetOnChange(resetKey, () => setPage(0));

  const slice = useMemo(() => pageSlice(items, page, pageSize), [items, page, pageSize]);
  return { ...slice, setPage };
};
