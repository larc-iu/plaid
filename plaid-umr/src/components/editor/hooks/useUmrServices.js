import { useCallback, useEffect, useRef } from 'react';
import { TASKS } from '@larc-iu/plaid-client';
import { useServiceRequest } from '@ui/hooks/useServiceRequest.js';
import { useServiceSpot } from '@ui/hooks/useServiceSpot.js';
import { useRunProgress, useMirroredProgress } from '@ui/hooks/useRunProgress.js';
import { writeRunRecord, clearRunRecord } from '@ui/domain/runRecord.js';
import { reloadAfterRun } from '@ui/lib/runReload.js';
import { notifyError } from '../../../utils/feedback.jsx';
import { COMPARE_STORAGE_ID, DRAFT_STORAGE_ID } from '../../../utils/serviceDefaults.js';
import { draftNotice } from '../../../domain/draftNotice.js';
import { compareNotice } from '../../../domain/compareNotice.js';

// How long a service may say NOTHING, not a cap on the run: the client restarts
// this clock on every progress event. A document is one model call per
// sentence, and a slow provider makes each of those a long quiet stretch, so it
// is generous.
const DRAFT_SILENCE_MS = 10 * 60 * 1000;
// A comparison is a metric over two documents already in hand: seconds, not
// minutes, and it reports as it goes.
const COMPARE_SILENCE_MS = 5 * 60 * 1000;

// The editor's integration spots, Draft and Compare, on the idiom every
// service run in every app wears (see @ui/components/services).
//
// The shell owns this hook and hands it down, so a run outlives the dialog it
// was started from AND a switch to another tab: the write lock, the banner and
// the progress all live above the tab that mounts the button.
export const useUmrServices = ({ client, projectId, doc, project, acquireWriteLock }) => {
  const request = useServiceRequest(client);
  const { discoverServices } = request;

  useEffect(() => {
    if (projectId) discoverServices(projectId);
  }, [projectId, discoverServices]);

  const draft = useSpotRun({
    request,
    task: TASKS.ANALYZE,
    storageId: DRAFT_STORAGE_ID,
    project,
    projectId,
    doc,
    acquireWriteLock,
    label: 'Draft',
    timeout: DRAFT_SILENCE_MS,
    copy: {
      successTitle: 'Drafted',
      successMessage: 'The draft finished.',
      errorTitle: 'Draft failed',
      errorMessage: 'The draft did not run.',
      stoppedTitle: 'Draft',
      // The write phase is one critical block with no checkpoint in it, so
      // a run reported as stopped stopped before writing.
      stoppedMessage: 'Nothing was written.',
      // The service authors the words and picks the severity. A run that
      // skipped every sentence warns rather than congratulates.
      notice: draftNotice,
    },
  });

  const compare = useSpotRun({
    request,
    task: TASKS.COMPARE,
    storageId: COMPARE_STORAGE_ID,
    project,
    projectId,
    doc,
    acquireWriteLock,
    label: 'Compare',
    timeout: COMPARE_SILENCE_MS,
    copy: {
      successTitle: 'Compared',
      successMessage: 'The comparison finished.',
      errorTitle: 'Comparison failed',
      errorMessage: 'The comparison did not run.',
      stoppedTitle: 'Compare',
      stoppedMessage: 'No report was written.',
      notice: compareNotice,
    },
  });

  return {
    isDiscovering: request.isDiscovering,
    isProcessing: request.isProcessing,
    discoverServices: useCallback(() => discoverServices(projectId), [discoverServices, projectId]),
    draft,
    compare,
  };
};

// One spot and its run, start to finish: the lock, the record, the request,
// the reload. `start(extra)` adds fixed request arguments the tab knows
// (Compare's `against`), which win over a same-named declared argument.
const useSpotRun = ({
  request,
  task,
  storageId,
  project,
  projectId,
  doc,
  acquireWriteLock,
  label,
  timeout,
  copy,
}) => {
  const { availableServices, requestService, cancelRequest, progressPercent, progressMessage } =
    request;

  const spot = useServiceSpot({
    task,
    project,
    services: availableServices,
    storageId,
  });

  const run = useRunProgress();
  useMirroredProgress(run, {
    percent: progressPercent,
    message: progressMessage,
    active: run.running,
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
          // The service's own declared arguments spread FIRST, so the fixed ones
          // below always win over a same-named argument.
          { ...spot.params.coerced(), ...extra, documentId: doc.id, projectId },
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
      copy,
    ],
  );

  return { spot, run, start, cancel: cancelRequest };
};
