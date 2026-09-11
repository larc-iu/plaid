import { useEffect, useRef } from 'react';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { EntryThreadIsland } from '@/components/documents/comments/island/EntryThreadIsland.js';

// Thin React shell around the vanilla EntryThreadIsland, the same shape as
// CommentsTab.jsx: React owns the mount lifecycle and nothing else, and the
// thread view is the one the document editor renders.
export const EntryComments = ({ store, itemId, caption, canWrite, canDeleteAny }) => {
  const hostRef = useRef(null);
  const islandRef = useRef(null);

  // The island is built once, so the confirm it holds reads through a ref and
  // its identity never has to change. Same dialog the React thread uses: two
  // renderings of a thread should not ask differently.
  const confirm = useConfirm();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  useEffect(() => {
    if (!store || !hostRef.current) return undefined;
    islandRef.current = new EntryThreadIsland(hostRef.current, {
      store,
      entityId: itemId,
      caption,
      canWrite,
      canDeleteAny,
      confirmDelete: (comment) =>
        confirmRef.current({
          title:
            comment.authorId === store.currentUserId
              ? 'Delete your comment?'
              : `Delete ${store.authorName(comment.authorId)}'s comment?`,
          description: 'Comments are not kept in the history, so this cannot be undone.',
          confirmLabel: 'Delete',
          destructive: true,
        }),
    });
    return () => {
      islandRef.current?.destroy();
      islandRef.current = null;
    };
    // The entry and permissions are synced below without tearing down the island.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  useEffect(() => {
    islandRef.current?.setEntry({ entityId: itemId, caption });
  }, [itemId, caption]);

  useEffect(() => {
    islandRef.current?.setPermissions({ canWrite, canDeleteAny });
  }, [canWrite, canDeleteAny]);

  return <div ref={hostRef} className="igt-comments-mount" />;
};
