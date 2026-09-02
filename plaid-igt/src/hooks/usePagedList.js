import { useEffect, useMemo, useState } from 'react';

// Rows per page for every browsable list in the app. A call site should never
// have to name a number, so that the lists page alike by default.
export const LIST_PAGE_SIZE = 100;

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

// Paging state for a client-side list. `resetKey` is whatever re-scopes the
// result set (the search text, the sort): when it changes the reader is looking
// at a different list, so page 1 is where they mean to be. Keep it a primitive,
// since it is an effect dependency.
export const usePagedList = (items, { pageSize = LIST_PAGE_SIZE, resetKey } = {}) => {
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [resetKey]);

  const slice = useMemo(() => pageSlice(items, page, pageSize), [items, page, pageSize]);
  return { ...slice, setPage };
};
