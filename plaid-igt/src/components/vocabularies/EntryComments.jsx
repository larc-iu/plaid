import { CommentThread } from '@ui/components/shared/CommentThread.jsx';
import { useCommentStore } from '@ui/domain/useCommentStore.js';
import { humanizeError } from '@/utils/feedback';

// One vocabulary entry's thread, for the entry panel on the vocabulary page.
// Keyed by the entry, so a half-typed comment is never carried into another
// entry's thread.
export const EntryComments = ({ store, itemId, caption, canWrite, canDeleteAny }) => {
  useCommentStore(store);
  if (!itemId) return null;
  if (!store.isLoaded) return <p className="text-sm text-muted-foreground">Loading comments…</p>;
  return (
    <div className="-mx-3">
      {store.error && (
        <p className="px-3 pb-2 text-sm text-destructive" role="alert">
          {humanizeError(store.error, store.error)}
        </p>
      )}
      <CommentThread
        key={itemId}
        store={store}
        comments={store.threadFor(itemId)}
        canWrite={canWrite}
        canDeleteAny={canDeleteAny}
        entityType="vocab-item"
        entityId={itemId}
        anchorLabel={caption}
      />
    </div>
  );
};
