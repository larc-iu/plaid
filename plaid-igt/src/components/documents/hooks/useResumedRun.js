import { useEffect, useRef } from 'react';
import { notifySuccess, notifyWarning, notifyInfo } from '@/utils/feedback';
import { clearRunRecord, readRunRecord } from '@/domain/runRecord';
import { useServiceRequest } from './useServiceRequest.js';

// Picks a service run back up after the page that started it went away.
//
// A request outlives its requester: the service keeps working, the server keeps
// its progress, and the result waits fifteen minutes. Without this, reloading
// the tab mid-run left the document editable while a service rewrote it, and
// the results appeared later with no explanation — the worst version of the
// thing the progress work was meant to prevent.
//
// Runs once per opened document. A record that names a request the server no
// longer knows (404: expired, or finished and collected) is simply forgotten.
export function useResumedRun(doc, acquireWriteLock) {
  const { attachToRequest, cancelRequest, progressPercent, progressMessage } = useServiceRequest();
  const documentId = doc?.id ?? null;
  // One attempt per document, even under StrictMode's double-invoke.
  const triedFor = useRef(null);
  // Progress arrives through the hook's state, so the live lock handle is kept
  // here for the effect below to push into.
  const lockRef = useRef(null);

  useEffect(() => {
    if (!documentId || triedFor.current === documentId) return;
    triedFor.current = documentId;

    const record = readRunRecord(documentId);
    if (!record) return;

    const lock = acquireWriteLock(record.label || 'A service', { onCancel: cancelRequest });
    if (!lock) return; // something already holds it; this page did not reload
    lockRef.current = lock;
    lock.setStatus('Rejoining…');

    (async () => {
      try {
        const result = await attachToRequest(record.projectId, record.requestId);
        lock.setStatus('Loading results…');
        await doc._reload();
        if (result?.stopped === true) {
          // Someone stopped it — from this page's banner, or another of their
          // tabs. Not a finish, and not a failure.
          notifyInfo('Stopped. What it had already written stays.', record.label);
        } else if (record.multiStep) {
          // Auto-analyze's steps are ordered here, in the browser, so the page
          // that went away took the rest of the run with it. Say so rather
          // than implying the whole thing finished.
          notifyWarning(
            `${record.label} was interrupted. The step that was running finished; the ones after it did not.`,
            record.label,
          );
        } else {
          notifySuccess(`${record.label} finished.`, record.label);
        }
      } catch (error) {
        if (error?.status === 404) {
          // Gone: it expired, or it finished and its result was collected by
          // the page that made it. Reload so anything it wrote is on screen.
          await doc._reload();
        } else {
          console.error('Could not rejoin the service request:', error);
          notifyWarning(`${record.label} could not be rejoined.`, record.label);
        }
      } finally {
        clearRunRecord(documentId);
        lock.release();
        lockRef.current = null;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  // Mirror the rejoined request's progress onto the lock, which is what the
  // banner renders.
  useEffect(() => {
    const lock = lockRef.current;
    if (!lock || !progressMessage) return;
    lock.setStatus(
      Number.isFinite(progressPercent)
        ? `${progressMessage} ${Math.round(progressPercent)}%`
        : progressMessage,
    );
  }, [progressPercent, progressMessage]);
}
