import { useSyncExternalStore } from 'react';

const noSubscribe = () => () => {};
const noSnapshot = () => 0;

/**
 * The save status over an open document, for the apps whose editors show no
 * save pill of their own (plaid-ud, plaid-umr). An edit is on screen before it
 * is sent, so a save on its way says nothing. What it does say is that a
 * refused edit's refetch is waiting for the connection to come back
 * (DocumentModel `isOffline`), while editing goes on.
 *
 * Always a live region, empty or not, so a screen reader hears it appear.
 */
export const SaveStatus = ({ doc }) => {
  useSyncExternalStore(doc?.subscribe ?? noSubscribe, doc?.getSnapshot ?? noSnapshot);
  if (!doc) return null;
  const offline = doc.isSaving && doc.isOffline;
  return (
    <span
      role="status"
      aria-live="polite"
      data-state={offline ? 'offline' : 'idle'}
      className={
        offline
          ? 'whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
          : undefined
      }
    >
      {offline ? 'Offline, retrying' : ''}
    </span>
  );
};
