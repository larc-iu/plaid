import { useEffect, useState } from 'react';
import { MessageSquare, MessageSquarePlus } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@ui/components/ui/popover';
import { CommentThread } from '@ui/components/shared/CommentThread';
import { useCommentStore } from '@ui/domain/useCommentStore';

// The comment badge on a sentence: its count, or a "+" when there is nothing
// yet and the reader may write. Opens the thread in a popover over the grid.
//
// The popover holds a LIVE claim while it is open, refcounted in the store, so
// two open threads and the Comments tab share one stream and the last to close
// closes it. A plain document load never opens one.
export const SentenceComments = ({ store, sentenceId, anchorLabel, canWrite, canDeleteAny }) => {
  const [open, setOpen] = useState(false);
  useCommentStore(store);

  useEffect(() => {
    if (!open) return undefined;
    return store?.watchLive();
  }, [open, store]);

  if (!store) return null;
  const count = store.countFor(sentenceId);
  // Nothing here and nothing to add: no affordance at all. A reader sees a
  // badge only where there is something to read.
  if (count === 0 && !canWrite) return null;

  const label =
    count > 0
      ? `${count} comment${count === 1 ? '' : 's'} on this sentence`
      : 'Comment on this sentence';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className={`sentence-comments${count > 0 ? ' sentence-comments--has' : ''}`}
          title={label}
          aria-label={label}
          onClick={() => setOpen((prev) => !prev)}
        >
          {count > 0 ? (
            <>
              <MessageSquare width={12} height={12} />
              <span className="tabular-nums">{count}</span>
            </>
          ) : (
            <MessageSquarePlus width={12} height={12} />
          )}
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-96 p-0"
        // The grid is a measured layout and a click inside the thread must not
        // reach the cell underneath.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b px-3 py-2 text-sm font-medium">{anchorLabel}</div>
        <div className="max-h-80 overflow-y-auto">
          <CommentThread
            store={store}
            comments={store.threadFor(sentenceId)}
            canWrite={canWrite}
            canDeleteAny={canDeleteAny}
            entityType="token"
            entityId={sentenceId}
            anchorLabel={anchorLabel}
            autoFocusComposer={count === 0}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
};
