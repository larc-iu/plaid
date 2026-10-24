import { useEffect, useRef } from 'react';
import { notifySuccess, notifyWarning, notifyInfo } from '../lib/notify.js';
import { showRunNotice } from '../lib/runNotice.js';
import { clearRunRecord, readRunRecord } from '../domain/runRecord.js';
import { reloadAfterRun } from '../lib/runReload.js';
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
//
// `notices` maps a task (the run record's `task`) to the app's notice
// function for it, the one the page that started the run passed as `notice`:
// it words the result's counts, so a rejoined run says what the run would
// have said on the page that started it (R18).
export function useResumedRun(client, doc, acquireWriteLock, notices = {}) {
  const { attachToRequest, cancelRequest, progressPercent, progressMessage } =
    useServiceRequest(client);
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

    // The record's start, so the banner's clock counts the whole run and not
    // just the time since the reload.
    const lock = acquireWriteLock(record.label || 'A service', {
      onCancel: cancelRequest,
      startedAt: record.startedAt,
    });
    if (!lock) return; // something already holds it; this page did not reload
    lockRef.current = lock;
    lock.setStatus('Rejoining…');

    let stillOut = false; // the request survived our giving up on it
    (async () => {
      try {
        const result = await attachToRequest(record.projectId, record.requestId);
        lock.setStatus('Loading results…');
        await reloadAfterRun(() => doc._reload());
        if (result?.stopped === true) {
          // Someone stopped it — from this page's banner, or another of their
          // tabs. Not a finish, and not a failure.
          notifyInfo('Stopped partway. What ran before the stop is in the document.', record.label);
        } else {
          // The app's words for the counts, as the page that started the run
          // would have shown them (useServiceRequest's `succeed`): a run that
          // failed every item still comes back a success, and only the counts
          // say so. A task the app words nothing for is said to have finished.
          const notice = record.task ? notices?.[record.task]?.(result) : null;
          if (record.multiStep) {
            // Auto-analyze's steps are ordered here, in the browser, so the
            // page that went away took the steps after this one with it. The
            // step's own words come first, then that the rest did not run.
            const after = 'The steps after it did not run.';
            notifyWarning(
              notice?.message
                ? `${notice.message} ${after}`
                : `The step that was running finished. ${after}`,
              record.label,
              ...(notice?.sticky ? [{ duration: Infinity }] : []),
            );
          } else if (notice) showRunNotice(notice);
          else notifySuccess(`${record.label} finished.`, record.label);
        }
      } catch (error) {
        if (error?.status === 404) {
          // Gone: it expired, or it finished and its result was collected by
          // the page that made it. Reload so anything it wrote is on screen.
          await reloadAfterRun(() => doc._reload());
        } else if (error?.pending) {
          // Still out there: we stopped waiting, it did not stop working. Keep
          // the record so the next reload rejoins it again. (attachToRequest
          // does not toast, unlike a submitted request, so this says it.)
          stillOut = true;
          notifyWarning(
            'Lost contact with the service. It is still running. Reload to pick it back up.',
            record.label,
          );
        } else {
          console.error('Could not rejoin the service request:', error);
          notifyWarning('Failed to rejoin the run.', record.label);
        }
      } finally {
        if (!stillOut) clearRunRecord(documentId);
        lock.release();
        // Only if it is still ours: the reader may have opened another
        // document while this was out, and that one's lock is what the banner
        // is mirroring now.
        if (lockRef.current === lock) lockRef.current = null;
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
