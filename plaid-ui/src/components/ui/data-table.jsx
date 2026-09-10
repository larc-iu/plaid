import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from './button.jsx';
import { SearchInput, ListCount, ListPager, SortHeader } from './list-search.jsx';
import { pageKey, usePagedList } from '../../hooks/usePagedList.js';
import { listPrefKey, useStickySort } from '../../hooks/useStickyState.js';

// One browsable table, so that a list of accounts, of invites and of services
// are told apart by their rows and by nothing else.
//
// The chrome was already shared (SearchInput, ListCount, ListPager,
// SortHeader) but the TABLE was not, so every screen hand-wrote its own
// `<thead>` and decided for itself whether to sort. Sorting ended up on five
// lists and missing from the rest, and the comparator was copied verbatim
// three times. This owns all of it: search, sort, paging, and the markup.
//
// A column is `{key, label, render, sort, align, className, headerClassName}`.
// `render(row)` draws the cell; `sort(row)` returns the value to order by, and
// a column WITHOUT it is simply not sortable. Rows arrive already filtered by
// whatever the caller filters on that this cannot know about (a status
// dropdown, a time window). Text search is this component's job when a
// `search` prop is given.
//
// `expand(row)` makes rows openable: it returns what to draw underneath one,
// in a full-width cell, and a chevron column appears in front. Use it when a
// row summarises a set that is too long to inline, the way one service
// summarises the projects it is registered on.

/**
 * Order two values, with a missing one counting as the smallest.
 *
 * A blank participates in the ordering rather than being pinned to one end,
 * so it flips with the column like every other value. That is what the data
 * usually means: a project with no last change is the least recently changed
 * one, so ascending "Last change" puts it first and descending puts it last.
 */
const compare = (a, b) => {
  if (a === b) return 0;
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing) return aMissing ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return a < b ? -1 : 1;
};

export const DataTable = ({
  rows,
  columns,
  rowKey,
  id,
  scope,
  rememberPage = false,
  defaultSort,
  search,
  noun = 'row',
  showCount = true,
  title,
  actions,
  empty = 'Nothing here.',
  noMatch,
  loading = false,
  expand,
  className,
}) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(() => new Set());

  if (import.meta.env?.DEV && !id) {
    // Without a name there is nowhere to keep the reader's choice, and two
    // unnamed tables would otherwise share one key and each other's order.
    console.error('DataTable needs an `id` to remember its sort.');
  }
  const sortable = useMemo(() => columns.filter((c) => c.sort).map((c) => c.key), [columns]);
  const [sort, onSort] = useStickySort(
    id ? listPrefKey('sort', id, scope) : null,
    defaultSort ?? { key: sortable[0], dir: 'asc' },
    sortable,
  );

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !search?.match) return rows;
    return rows.filter((row) => search.match(row, q));
  }, [rows, query, search]);

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sort.key && c.sort);
    if (!column) return matched;
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Sorted on a COPY, and the key is the tiebreak so equal values keep a
    // stable order instead of shuffling between renders.
    return [...matched].sort((a, b) => {
      const primary = compare(column.sort(a), column.sort(b));
      return primary !== 0 ? primary * dir : compare(rowKey(a), rowKey(b));
    });
  }, [matched, columns, sort, rowKey]);

  const paged = usePagedList(sorted, {
    resetKey: `${query}:${sort.key}:${sort.dir}`,
    storageKey: rememberPage && id ? pageKey(id, scope) : undefined,
  });

  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // An empty bar is worse than none, so the toolbar appears only when it has
  // something in it. A count alone is not something: "0 links" above "No
  // invitation links yet." says nothing the empty state has not already said.
  // `showCount` is off where the caller states a richer count of its own, as
  // the frequency table does.
  const showToolbar = title || search || actions || (showCount && rows.length > 0);
  const span = columns.length + (expand ? 1 : 0);

  return (
    <div className={cn('rounded-md border', className)}>
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {title && <h3 className="text-sm font-semibold">{title}</h3>}
          {search && (
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={search.placeholder || 'Search…'}
              className={cn('max-w-[16rem]', title && 'ml-auto')}
            />
          )}
          {showCount && <ListCount shown={matched.length} total={rows.length} noun={noun} />}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}

      <ListPager {...paged} onPage={paged.setPage} position="top" />

      {loading && rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : paged.pageItems.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          {rows.length === 0
            ? empty
            : typeof noMatch === 'function'
              ? noMatch(query.trim())
              : noMatch || `No ${noun}s match.`}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                {expand && <th className="w-8 px-1 py-2" />}
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={cn(
                      'px-3 py-2 font-medium',
                      c.align === 'right' && 'text-right',
                      c.headerClassName,
                    )}
                  >
                    {c.sort ? (
                      <SortHeader field={c.key} label={c.label} sort={sort} onSort={onSort} />
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.pageItems.map((row) => {
                const key = rowKey(row);
                const isOpen = open.has(key);
                return (
                  <React.Fragment key={key}>
                    <tr className={cn('border-b hover:bg-accent/40', isOpen && 'bg-accent/30')}>
                      {expand && (
                        <td className="px-1 py-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? 'Collapse' : 'Expand'}
                            onClick={() => toggle(key)}
                          >
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </td>
                      )}
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn(
                            'px-3 py-2',
                            c.align === 'right' && 'text-right',
                            c.className,
                          )}
                        >
                          {c.render ? c.render(row) : null}
                        </td>
                      ))}
                    </tr>
                    {isOpen && (
                      <tr className="border-b bg-muted/40">
                        <td colSpan={span} className="px-3 py-2">
                          {expand(row)}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ListPager {...paged} onPage={paged.setPage} position="bottom" />
    </div>
  );
};
