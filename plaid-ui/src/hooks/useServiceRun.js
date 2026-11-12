import { useCallback } from 'react';
import { useServiceSpot } from './useServiceSpot.js';
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
  const { availableServices, requestService, cancelRequest } = request;

  const spot = useServiceSpot({
    task,
    project,
    services: availableServices,
    builtins,
    storageId,
    seedParams,
  });

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
      lock.report({ message: 'Starting the service…' });
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
            // The banner shows the run, and it outlives the tab that started it.
            onProgress: lock.onProgress,
            // Written down before the request is submitted, so a reload in that
            // window can still find the run.
            onRequestId: (requestId) =>
              writeRunRecord(doc.id, { requestId, projectId, label, task }),
          },
        );
        // Re-reading a large document is seconds of work, so it is named rather
        // than left as dead air.
        lock.report({ percent: null, message: 'Loading results…' });
        await reloadAfterRun(() => doc.reload());
      } catch (error) {
        // requestService has already said it out loud; log so a failed run does
        // not toast twice.
        console.error(`${label} failed:`, error);
        stillOut = error?.pending === true;
        // A run that failed may still have written (its answer lost, or
        // stopped partway), so the document is read again. Not while it is
        // still out: its results are read when it finishes.
        if (!stillOut) {
          await doc
            .reload()
            .catch((err) => console.error(`Reload after the failed ${label} failed:`, err));
        }
      } finally {
        if (!stillOut) clearRunRecord(doc.id);
        lock.release();
      }
    },
    [
      acquireWriteLock,
      cancelRequest,
      requestService,
      projectId,
      doc,
      spot,
      label,
      timeout,
      args,
      copy,
      task,
    ],
  );

  return { spot, start };
};
