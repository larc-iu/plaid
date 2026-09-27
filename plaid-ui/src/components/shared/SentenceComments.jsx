import { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover.jsx';
import { CommentThread } from './CommentThread.jsx';
import { useCommentStore } from '../../domain/useCommentStore.js';
import { cn } from '../../lib/utils.js';

/**
 * The Comment action on one sentence of an annotation editor: a small icon and
 * label with the count beside it when there is one, opening the sentence's
 * thread in a popover over the grid.
 *
 * Props:
 * - `store`: the document's CommentStore. Nothing renders without one.
 * - `sentenceId`: the sentence token's id, the thread's anchor.
 * - `anchorLabel`: the caption the popover heads the thread with, and what a
 *   comment shows once its sentence is gone.
 * - `canWrite`, `canDeleteAny`: as for CommentThread.
 * - `className`: the host's own class for the button, so it can wear the
 *   host's treatment of the actions beside it (plaid-ud: `sentence-action`).
 *
 * Only the COUNT colours in, because a sentence someone has written on is a
 * fact about the sentence and not a state of the button. A reader with nothing
 * to read gets no button at all.
 *
 * The popover holds a LIVE claim while it is open, refcounted in the store, so
 * two open threads and the Comments tab share one stream and the last to close
 * closes it. A plain document load never opens one.
 */
export const SentenceComments = ({
  store,
  sentenceId,
  anchorLabel,
  canWrite,
  canDeleteAny,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  // Whether the thread closed because the reader clicked elsewhere, where
  // focus belongs to what they clicked.
  const leftOutside = useRef(false);
  useCommentStore(store);

  useEffect(() => {
    if (!open) return undefined;
    return store?.watchLive();
  }, [open, store]);

  if (!store) return null;
  const count = store.countFor(sentenceId);
  if (count === 0 && !canWrite) return null;

  const label =
    count > 0
      ? `${count} comment${count === 1 ? '' : 's'} on this sentence`
      : 'Comment on this sentence';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          ref={buttonRef}
          type="button"
          className={cn(
            'sentence-comments inline-flex h-6 cursor-pointer items-center gap-1 rounded border border-transparent bg-transparent px-2 text-xs text-gray-700 hover:bg-gray-100 hover:text-gray-900',
            className,
          )}
          data-count={count}
          title={label}
          aria-label={label}
          onClick={() => setOpen((prev) => !prev)}
        >
          <MessageSquare width={12} height={12} />
          Comment
          {count > 0 && <span className="font-medium tabular-nums text-primary">{count}</span>}
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-96 p-0"
        // The grid is a measured layout and a click inside the thread must not
        // reach the cell underneath.
        onClick={(event) => event.stopPropagation()}
        // Nor a key: the thread is portaled, but React bubbles its events
        // through the host's grid or canvas, where Enter means something else.
        onKeyDown={(event) => event.stopPropagation()}
        // The popover hangs off an anchor, not a Radix trigger, so Radix has
        // nowhere to put focus back: Escape would leave the reader on the page's
        // body, out of the grid or the canvas.
        onOpenAutoFocus={() => {
          leftOutside.current = false;
        }}
        onInteractOutside={() => {
          leftOutside.current = true;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!leftOutside.current) buttonRef.current?.focus();
        }}
      >
        <div className="border-b px-3 py-2 text-sm font-medium" dir="auto">
          {anchorLabel}
        </div>
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
