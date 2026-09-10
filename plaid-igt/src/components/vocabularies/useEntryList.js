import { useEffect, useMemo, useRef } from 'react';
import { pageSlice, pageKey, useResetOnChange, LIST_PAGE_SIZE } from '@/hooks/usePagedList';
import { listPrefKey, useStickyState, useStickySort } from '@/hooks/useStickyState';
import { filterVocabItems, sortVocabItems } from '@/domain/vocabItemFilter';
import { arrangeAsTree } from '@/domain/vocabDictionary';
import { NEW_ID } from './vocabItemsState';

// The columns this list sorts by, named once so a remembered sort on a column
// that is no longer here is rejected rather than reaching the comparator.
const ITEM_COLUMNS = ['form', 'gloss', 'uses'];

// The left list as rows: the entries the scope keeps, in the remembered
// order and view, paged, and kept positioned on the open entry. The sort,
// page, and view are remembered per vocabulary.
export function useEntryList({
  vocabularyId,
  items,
  scope,
  emptyOnly,
  offTagsetIds,
  fieldNames,
  searchTextOf,
  numbers,
  usageCounts,
  tree,
  selectedId,
}) {
  const [sort, onSort] = useStickySort(
    listPrefKey('sort', 'vocab-items', vocabularyId),
    { key: 'form', dir: 'asc' },
    ITEM_COLUMNS,
  );
  const [page, setPage] = useStickyState(
    pageKey('vocab-items', vocabularyId),
    0,
    (v) => Number.isInteger(v) && v >= 0,
  );
  const [treeView, setTreeView] = useStickyState(
    listPrefKey('view', 'vocab-items', vocabularyId),
    true,
    (v) => typeof v === 'boolean',
  );
  const listRef = useRef(null);

  const filteredItems = useMemo(
    () =>
      sortVocabItems(
        filterVocabItems(
          scope.offTagsetOnly ? items.filter((it) => offTagsetIds.has(it.id)) : items,
          {
            query: scope.search,
            field: scope.field,
            emptyOnly,
            fieldNames,
            textOf: searchTextOf,
          },
        ),
        sort,
        { numbers, usageCounts },
      ),
    [
      items,
      scope.search,
      scope.field,
      scope.offTagsetOnly,
      emptyOnly,
      fieldNames,
      searchTextOf,
      numbers,
      usageCounts,
      sort,
      offTagsetIds,
    ],
  );

  // The rows the list draws: in the tree view an entry's senses follow it,
  // indented, when they are in the result set too (see arrangeAsTree).
  //
  // The whole result set is laid out and THEN paged, never the other way
  // round. Arranging one page at a time draws a headword twice when the page
  // boundary falls between it and its senses: once as a match at the foot of
  // one page, once dimmed as their context at the head of the next.
  const listRows = useMemo(
    () =>
      treeView
        ? arrangeAsTree(filteredItems, tree)
        : filteredItems.map((item) => ({ item, depth: 0 })),
    [treeView, filteredItems, tree],
  );

  // Paged with the shared helper rather than the hook: the positioning effect
  // below needs to drive the page itself, so the state stays local. The count
  // above the list reports MATCHES while this pages ROWS, which differ in the
  // tree view by the context rows: two true numbers about two different
  // things, and the context rows are drawn dimmed to say which is which.
  const paged = pageSlice(listRows, page);
  const currentPage = paged.page;

  // Reset to page 1 when the result set is re-scoped, and only then, so the
  // page this vocabulary was left on survives the mount; jump the list back to
  // top when the page changes.
  useResetOnChange(
    `${scope.search}|${scope.field}|${emptyOnly}|${scope.offTagsetOnly}|${sort.key}|${sort.dir}|${treeView}`,
    () => setPage(0),
  );
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [currentPage]);

  // Keep the selected entry findable in the list: whenever the selection moves
  // to one that is not on the page being shown (a link from the Analyze
  // popover, a URL someone sent, a reload, the back button), turn to its page
  // and scroll it into view. The list itself is left alone (filtering it down
  // to the one entry would throw away the context a reader arrived to browse)
  // and a row that is already on screen is never nudged, so clicking through
  // the list keeps it still. Declared after the scroll-to-top above so it runs
  // after it in the same commit; a layout effect would be undone by that reset.
  const positionedRef = useRef(null);
  useEffect(() => {
    if (!selectedId || selectedId === NEW_ID || positionedRef.current === selectedId) return;
    const index = listRows.findIndex((r) => r.item.id === selectedId);
    if (index < 0) return; // not loaded yet, or the search box has it filtered out
    const wanted = Math.floor(index / LIST_PAGE_SIZE);
    if (currentPage !== wanted) {
      setPage(wanted);
      return; // scroll once the right page has rendered
    }
    positionedRef.current = selectedId;
    const row = listRef.current?.querySelector('[data-selected="true"]');
    const pane = listRef.current?.getBoundingClientRect();
    if (!row || !pane) return;
    const r = row.getBoundingClientRect();
    if (r.top < pane.top || r.bottom > pane.bottom) row.scrollIntoView({ block: 'center' });
  }, [selectedId, listRows, currentPage, setPage]);

  return { filteredItems, listRows, paged, setPage, sort, onSort, treeView, setTreeView, listRef };
}
