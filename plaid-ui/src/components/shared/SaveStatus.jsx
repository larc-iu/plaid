import { useEffect, useState, useSyncExternalStore } from 'react';
import { isOnline, onOnlineChange } from '../../lib/retrying.js';
import { saveStateOf, saveStateText } from '../../lib/saveState.js';

const noSubscribe = () => () => {};
const noSnapshot = () => 0;

// How long a save goes unanswered before the status says "Saving…".
const SLOW_SAVE_MS = 3000;

/**
 * The save status over an open document, for the editors that show no save
 * pill of their own (plaid-ud, plaid-umr, igt's tabs but Analyze), and igt's
 * vocabulary page. An edit is on screen before it is sent, so a save on its
 * way says nothing until it has gone `SLOW_SAVE_MS` without an answer, and
 * then "Saving…" (PB-12). It also says that a write or a refetch is being sent again until the server
 * answers (DocumentModel `isOffline`), or waits for someone else's lock on the
 * document to go (`isLocked`), while editing goes on.
 *
 * Always a live region, empty or not, so a screen reader hears it appear.
 */
export const SaveStatus = ({ doc }) => {
  useSyncExternalStore(doc?.subscribe ?? noSubscribe, doc?.getSnapshot ?? noSnapshot);
  // The wording names the browser's network, which changes with nothing else.
  useSyncExternalStore(onOnlineChange, isOnline);
  // Whether the saves running now started SLOW_SAVE_MS ago or more: one timer
  // from when `isSaving` turns true, ended when it turns false.
  const isSaving = !!doc?.isSaving;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!isSaving) return undefined;
    const timer = setTimeout(() => setLate(true), SLOW_SAVE_MS);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [isSaving]);
  if (!doc) return null;
  // A save simply on its way says nothing here, since the edit shows already,
  // until it has gone unanswered for a while.
  const saving = saveStateOf(doc);
  const waiting = saving === 'offline' || saving === 'locked' || (saving === 'saving' && late);
  const state = waiting ? saving : 'idle';
  return (
    <span
      role="status"
      aria-live="polite"
      data-state={state}
      className={
        waiting
          ? 'whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
          : undefined
      }
    >
      {saveStateText(state)}
    </span>
  );
};
