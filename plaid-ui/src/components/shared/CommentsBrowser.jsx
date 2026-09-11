import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CornerUpRight } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { SearchInput, ListCount, ListPager } from '../ui/list-search.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.jsx';
import { usePagedList } from '../../hooks/usePagedList.js';
import { useCommentStore } from '../../domain/useCommentStore.js';
import { threadList, plainText } from '../../domain/commentThreads.js';
import { CommentThread } from './CommentThread.jsx';

// Every thread on one document (or one vocabulary), with the list chrome around
// it: search, count, sort, Current / Outdated, a pager top and bottom.
//
// `anchors` is the entity index the threads are described by — each app builds
// its own, since only the app knows what a "sentence 4" is (see
// domain/commentAnchors.js). `pinnedId` is the thread always shown first, which
// for a document is its own.
//
// A thread is collapsed to its latest comment and opens on click. A document's
// worth of threads is a list to scan, not a conversation to read end to end.

const ThreadRow = ({
  thread,
  store,
  canWrite,
  canDeleteAny,
  onJumpTo,
  jumpTitle,
  open,
  onToggle,
}) => {
  const latest = thread.comments[thread.comments.length - 1];
  const more = thread.comments.length - 1;
  const { label, detail, jumpId } = thread.anchor;
  return (
    <li className="border-b last:border-b-0">
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={open ? 'Collapse this thread' : 'Open this thread'}
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {label}
            {detail && <span className="font-normal text-muted-foreground">{detail}</span>}
            {thread.outdated && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-800">
                outdated
              </span>
            )}
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              {thread.comments.length}
            </span>
          </span>
          {!open && latest && (
            <span className="mt-0.5 block truncate text-sm text-muted-foreground">
              {plainText(latest.body)}
              {more > 0 && <span className="ml-1 text-xs">+{more}</span>}
            </span>
          )}
        </button>
        {onJumpTo && jumpId && (
          <button
            type="button"
            className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={jumpTitle}
            aria-label={jumpTitle}
            onClick={() => onJumpTo(jumpId)}
          >
            <CornerUpRight className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && (
        <div className="border-t bg-muted/10">
          <CommentThread
            store={store}
            comments={thread.comments}
            canWrite={canWrite}
            canDeleteAny={canDeleteAny}
            entityType={thread.entityType}
            entityId={thread.entityId}
            anchorLabel={thread.caption}
          />
        </div>
      )}
    </li>
  );
};

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
  const [openId, setOpenId] = useState(null);

  const list = useMemo(
    () => (store ? threadList(store, anchors, { query, sort, pinnedId, pinnedType }) : null),
    // `version` is the store's change counter: the list is rebuilt on every
    // emit (load, post, edit, delete, live update).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, anchors, query, sort, pinnedId, pinnedType, version],
  );
  const shown = list ? (filter === 'outdated' ? list.outdated : list.current) : [];
  const total = list ? (filter === 'outdated' ? list.outdatedTotal : list.currentTotal) : 0;
  const paged = usePagedList(shown, { resetKey: `${query}|${sort}|${filter}` });

  if (!store) return null;

  const rows = [...(filter === 'current' && list?.pinned ? [list.pinned] : []), ...paged.pageItems];
  const q = query.trim();

  return (
    <div className="mt-2">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ListCount shown={shown.length} total={total} noun="thread" />
        <SearchInput
          className="w-56"
          placeholder="Search comments…"
          value={query}
          onChange={setQuery}
        />
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
        {rows.length ? (
          <ul>
            {rows.map((thread) => (
              <ThreadRow
                key={thread.entityId}
                thread={thread}
                store={store}
                canWrite={canWrite}
                canDeleteAny={canDeleteAny}
                onJumpTo={onJumpTo}
                jumpTitle={jumpTitle}
                open={openId === thread.entityId}
                onToggle={() =>
                  setOpenId((prev) => (prev === thread.entityId ? null : thread.entityId))
                }
              />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {q
              ? `No comments match “${q}”.`
              : filter === 'outdated'
                ? 'No outdated comments.'
                : emptyText}
          </p>
        )}
        <ListPager {...paged} onPage={paged.setPage} />
      </div>
    </div>
  );
};
