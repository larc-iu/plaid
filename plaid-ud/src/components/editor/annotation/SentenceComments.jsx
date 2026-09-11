import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@ui/components/ui/popover';
import { CommentThread } from '@ui/components/shared/CommentThread';
import { useCommentStore } from '@ui/domain/useCommentStore';

// The comment action on a sentence, one of the four the strip under the grid
// offers: the same dimmed icon and label the other three wear
// (`sentence-action`), with the count beside it when there is one. Opens the
// thread in a popover over the grid.
//
// Only the COUNT colours in, because a sentence someone has written on is a
// fact about the sentence and not a state of the button.
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
          className={`sentence-comments sentence-action${count > 0 ? ' sentence-comments--has' : ''}`}
          title={label}
          aria-label={label}
          onClick={() => setOpen((prev) => !prev)}
        >
          <MessageSquare width={12} height={12} />
          Comment
          {count > 0 && <span className="tabular-nums">{count}</span>}
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
