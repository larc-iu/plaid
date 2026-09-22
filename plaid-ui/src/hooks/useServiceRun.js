import { useCallback, useEffect, useRef } from 'react';
import { useServiceSpot } from './useServiceSpot.js';
import { useRunProgress, useMirroredProgress } from './useRunProgress.js';
import { writeRunRecord, clearRunRecord } from '../domain/runRecord.js';
import { reloadAfterRun } from '../lib/runReload.js';
import { notifyError } from '../lib/notify.js';

/**
 * One integration spot and its run, start to finish: the service a maintainer
 * chose for the spot, the write lock, the run record, the request, and the
 * re-read afterwards.
 *
 * This is the idiom every service run in every app wears (see
 * `../components/services`), and it was written out once per spot: Parse and
 * Tokenize in plaid-ud, Draft and Compare in plaid-umr, Tokenize in plaid-igt.
 *
 * `request` is a `useServiceRequest(client)`, shared by every spot on a
 * document: the write lock already allows one run at a time, so a second could
 * never be in flight, and sharing means Stop and the progress line always name
 * what is actually running.
 *
 * `start(extra)` adds fixed request arguments the call site knows (the layer
 * ids a tokenizer needs, the document a comparison is against); they win over
 * a same-named argument the service declared.
 */
export const useServiceRun = ({
  request,
  task,
  storageId,
  builtins,
  seedParams,
  project,
  projectId,
  doc,
  acquireWriteLock,
  label,
  timeout,
  args,
  copy,
}) => {
  const { availableServices, requestService, cancelRequest, progressPercent, progressMessage } =
    request;

  const spot = useServiceSpot({
    task,
    project,
    services: availableServices,
    builtins,
    storageId,
    seedParams,
  });

  const run = useRunProgress();
  useMirroredProgress(run, {
    percent: progressPercent,
    message: progressMessage,
    // A spot with a builtin can run without a service, here in the browser,
    // and that run has progress of its own: mirroring the request's would
    // report a run nobody made.
    active: run.running && !!spot.service,
  });

  // The banner is the only surface once the dialog is shut and the user has
  // moved to another tab.
  const lockRef = useRef(null);
  useEffect(() => {
    if (progressMessage) lockRef.current?.setStatus(progressMessage);
  }, [progressMessage]);

  const start = useCallback(
    async (extra = {}) => {
      const missing = Object.values(spot.params.errors);
      if (missing.length) {
        notifyError(missing[0], 'Missing required option');
        return;
      }
      if (!spot.service) return;
      const lock = acquireWriteLock(label, { onCancel: cancelRequest });
      if (!lock) return;
      lockRef.current = lock;
      run.start([label]);
      let stillOut = false; // the request survived our giving up on it
      try {
        await requestService(
          projectId,
          doc.id,
          spot.service.serviceId,
          // The service's own declared arguments spread FIRST, so the fixed
          // ones below always win over a same-named argument.
          { ...spot.params.coerced(), ...args, ...extra, documentId: doc.id },
          {
            timeout,
            ...copy,
            // Written down before the request is submitted, so a reload in that
            // window can still find the run.
            onRequestId: (requestId) => writeRunRecord(doc.id, { requestId, projectId, label }),
          },
        );
        // Re-reading a large document is seconds of work, so it is named rather
        // than left as dead air.
        run.report({ percent: null, message: 'Loading results…' });
        lock.setStatus('Loading results…');
        await reloadAfterRun(() => doc.reload());
      } catch (error) {
        // requestService has already said it out loud; log so a failed run does
        // not toast twice.
        console.error(`${label} failed:`, error);
        stillOut = error?.pending === true;
      } finally {
        if (!stillOut) clearRunRecord(doc.id);
        run.finish();
        lockRef.current = null;
        lock.release();
      }
    },
    [
      acquireWriteLock,
      cancelRequest,
      requestService,
      projectId,
      doc,
      run,
      spot,
      label,
      timeout,
      args,
      copy,
    ],
  );

  return { spot, run, start, cancel: cancelRequest };
};
