import { useEffect, useMemo, useRef } from 'react';
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

// Paging state for a client-side list. `resetKey` is whatever re-scopes the
// result set (the search text, the sort): when it changes the reader is looking
// at a different list, so page 1 is where they mean to be. Keep it a primitive,
// since it is an effect dependency. `storageKey` (from `pageKey`) remembers the
// page across visits; without one the paging is per-mount as before.
export const usePagedList = (items, { pageSize = LIST_PAGE_SIZE, resetKey, storageKey } = {}) => {
  const [page, setPage] = useStickyState(storageKey ?? null, 0, isPage);

  useResetOnChange(resetKey, () => setPage(0));

  const slice = useMemo(() => pageSlice(items, page, pageSize), [items, page, pageSize]);
  return { ...slice, setPage };
};
