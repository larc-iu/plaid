import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SearchInput, ListCount, ListPager } from '@/components/ui/list-search';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { usePagedList } from '@/hooks/usePagedList';
import { useCommentStore } from '@/domain/useCommentStore';
import { threadList } from '@/domain/commentThreads';
import { CommentsIsland } from './island/CommentsIsland.js';

// The Comments tab, for a document or a vocabulary: the app's list chrome
// (search, count, sort, pager) around the vanilla CommentsIsland. React owns
// which threads are shown; the island owns rendering them, so the thread view
// stays shared with the Analyze grid's popover.
//
// `anchors` is the entity index the threads are described by (see
// commentAnchors.js); `pinnedId` is the thread always shown first (a
// document's own), or null.
export const CommentsBrowser = ({
  store,
  anchors,
  pinnedId = null,
  pinnedType = 'document',
  canWrite,
  canDeleteAny,
  onJumpTo,
  jumpTitle,
  emptyText,
  positionLabel = 'In text order',
}) => {
  useCommentStore(store);
  const version = store?.getSnapshot?.() ?? 0;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [filter, setFilter] = useState('current');

  const list = useMemo(
    () => (store ? threadList(store, anchors, { query, sort, pinnedId, pinnedType }) : null),
    // `version` is the store's change counter: the list is rebuilt on every emit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, anchors, query, sort, pinnedId, pinnedType, version],
  );
  const shown = list ? (filter === 'outdated' ? list.outdated : list.current) : [];
  const total = list ? (filter === 'outdated' ? list.outdatedTotal : list.currentTotal) : 0;
  const paged = usePagedList(shown, { resetKey: `${query}|${sort}|${filter}` });

  const hostRef = useRef(null);
  const islandRef = useRef(null);
  useEffect(() => {
    if (!store || !hostRef.current) return undefined;
    islandRef.current = new CommentsIsland(hostRef.current, {
      store,
      canWrite,
      canDeleteAny,
      onJumpTo,
      jumpTitle,
    });
    return () => {
      islandRef.current?.destroy();
      islandRef.current = null;
    };
    // Threads and permissions are synced below without tearing down the island.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  useEffect(() => {
    if (!list) return;
    const q = query.trim();
    islandRef.current?.setThreads({
      pinned: list.pinned,
      threads: paged.pageItems,
      emptyText: q
        ? `No comments match “${q}”.`
        : filter === 'outdated'
          ? 'No outdated comments.'
          : emptyText,
    });
  }, [list, paged.pageItems, query, filter, emptyText]);

  useEffect(() => {
    islandRef.current?.setPermissions({ canWrite, canDeleteAny });
  }, [canWrite, canDeleteAny]);

  if (!store) return null;

  return (
    <div className="tw mt-2">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput
          className="w-56"
          placeholder="Search comments…"
          value={query}
          onChange={setQuery}
        />
        <ListCount shown={shown.length} total={total} noun="thread" />
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="h-8 w-40" aria-label="Sort threads">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Latest activity</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="position">{positionLabel}</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Which threads">
          <Button
            size="sm"
            variant={filter === 'current' ? 'secondary' : 'ghost'}
            aria-pressed={filter === 'current'}
            onClick={() => setFilter('current')}
          >
            Current
            <span className="ml-1 tabular-nums text-muted-foreground">
              {list?.currentTotal ?? 0}
            </span>
          </Button>
          <Button
            size="sm"
            variant={filter === 'outdated' ? 'secondary' : 'ghost'}
            aria-pressed={filter === 'outdated'}
            onClick={() => setFilter('outdated')}
          >
            Outdated
            <span className="ml-1 tabular-nums text-muted-foreground">
              {list?.outdatedTotal ?? 0}
            </span>
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-md border bg-card">
        <ListPager {...paged} onPage={paged.setPage} position="top" />
        <div ref={hostRef} className="igt-comments-mount" />
        <ListPager {...paged} onPage={paged.setPage} />
      </div>
    </div>
  );
};
