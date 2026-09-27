import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, CornerUpRight } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { SearchInput, ListCount, ListPager } from './list-search.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.jsx';
import { usePagedList, TALL_LIST_PAGE_SIZE } from '../../hooks/usePagedList.js';
import { useCommentStore } from '../../domain/useCommentStore.js';
import { threadList, plainText } from '../../domain/commentThreads.js';
import { detectDirection } from '../../domain/textDirection.js';
import { CommentThread } from './CommentThread.jsx';

// Every thread on one document (or one vocabulary), with the list chrome around
// it: search, count, sort, Current / Outdated, a pager top and bottom.
//
// `anchors` is the entity index the threads are described by: each app builds
// its own, since only the app knows what a "sentence 4" is (see
// domain/commentAnchors.js). `pinnedId` is the thread always shown first, which
// for a document is its own.
//
// A thread is collapsed to its latest comment and opens on click. A document's
// worth of threads is a list to scan, not a conversation to read end to end.

// The line under a thread's label: where it sits ("sentence 4", "in ktab,
// sentence 4"), and where the anchor carries one, an `excerpt` of the text
// inside it. The excerpt is a sentence, so it reads the way most of its
// letters do, since its first word may be a Latin name. Only the excerpt is
// counted and isolated: the app's own words around it ("Sentence 4 · “")
// would otherwise vote, and a right-to-left line would move them to its end.
const AnchorDetail = ({ detail, excerpt }) => {
  const at = excerpt ? detail.indexOf(excerpt) : -1;
  const className = 'font-normal text-muted-foreground';
  if (at < 0) {
    return (
      <span dir="auto" className={className}>
        {detail}
      </span>
    );
  }
  const dir = detectDirection(excerpt);
  if (detail === excerpt) {
    return (
      <span dir={dir} className={className}>
        {detail}
      </span>
    );
  }
  return (
    <span dir="auto" className={className}>
      {detail.slice(0, at)}
      <bdi dir={dir}>{excerpt}</bdi>
      {detail.slice(at + excerpt.length)}
    </span>
  );
};

const ThreadRow = ({
  thread,
  store,
  canWrite,
  canDeleteAny,
  jumpHref,
  jumpTitle,
  open,
  onToggle,
}) => {
  const latest = thread.comments[thread.comments.length - 1];
  const more = thread.comments.length - 1;
  const { label, detail, excerpt, jumpId } = thread.anchor;
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
            {/* The word, value or entry this thread is about. */}
            <span dir="auto">{label}</span>
            {detail && <AnchorDetail detail={detail} excerpt={excerpt} />}
            {thread.outdated && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-normal text-warning-foreground">
                outdated
              </span>
            )}
            {/* The pinned thread is synthesized with no comments when the
                document has none, so a literal "0" sat beside its label. */}
            {thread.comments.length > 0 && (
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {thread.comments.length}
              </span>
            )}
          </span>
          {!open && latest && (
            <span dir="auto" className="mt-0.5 block truncate text-sm text-muted-foreground">
              {plainText(latest.body)}
              {more > 0 && <span className="ms-1 text-xs">+{more}</span>}
            </span>
          )}
        </button>
        {jumpHref && jumpId && (
          <Link
            to={jumpHref(jumpId)}
            className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={jumpTitle}
            aria-label={jumpTitle}
          >
            <CornerUpRight className="h-4 w-4" />
          </Link>
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
  jumpHref,
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
  // The pinned thread sits above the Current list and outside `threadList`'s
  // counts, but once it has a comment it is a thread on screen like the rest,
  // so it is counted with them. Empty, it is only the place to start one.
  const pinnedCount = list?.pinned?.comments.length ? 1 : 0;
  const currentTotal = (list?.currentTotal ?? 0) + pinnedCount;
  const total = list ? (filter === 'outdated' ? list.outdatedTotal : currentTotal) : 0;
  const shownCount = shown.length + (filter === 'current' ? pinnedCount : 0);
  // A thread row is a label line plus a truncated latest comment, and it
  // opens in place into a whole conversation: the taller of the two page
  // sizes, like every other multi-line list.
  const paged = usePagedList(shown, {
    pageSize: TALL_LIST_PAGE_SIZE,
    resetKey: `${query}|${sort}|${filter}`,
  });

  if (!store) return null;

  // The document's own thread is pinned to the TOP OF THE LIST, which is page
  // one: prepending it to every page put it above rows it has nothing to do
  // with.
  const pinned = filter === 'current' && paged.page === 0 ? list?.pinned : null;
  const rows = [...(pinned ? [pinned] : []), ...paged.pageItems];
  const q = query.trim();

  return (
    <div className="mt-2">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ListCount shown={shownCount} total={total} noun="thread" />
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
            <span className="ml-1 tabular-nums text-muted-foreground">{currentTotal}</span>
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
                jumpHref={jumpHref}
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
