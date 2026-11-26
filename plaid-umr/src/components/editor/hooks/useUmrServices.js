import { useCallback, useEffect, useMemo } from 'react';
import { useServiceRequest } from '@ui/hooks/useServiceRequest.js';
import { useServiceRun } from '@ui/hooks/useServiceRun.js';
import {
  COMPARE_SPOT,
  COMPARE_STORAGE_ID,
  DRAFT_SPOT,
  DRAFT_STORAGE_ID,
} from '../../../utils/serviceDefaults.js';
import { draftNotice } from '../../../domain/draftNotice.js';
import { compareNotice } from '../../../domain/compareNotice.js';
import { t } from '@ui/lib/i18n.js';

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

  // Both services take the project as well as the document. Memoized because
  // the run holds on to it: a fresh object every render would rebuild `start`.
  const requestArgs = useMemo(() => ({ projectId }), [projectId]);

  const draft = useServiceRun({
    request,
    task: DRAFT_SPOT.key,
    storageId: DRAFT_STORAGE_ID,
    project,
    projectId,
    doc,
    acquireWriteLock,
    // The run's name, which the write lock holds: DraftDialog names it the
    // same, so its button knows the run as its own.
    label: t('Draft'),
    timeout: DRAFT_SILENCE_MS,
    args: requestArgs,
    copy: {
      successTitle: t('Drafted'),
      successMessage: t('The draft finished.'),
      errorTitle: t('Failed to draft'),
      errorMessage: t('The draft did not run.'),
      stoppedTitle: t('Draft'),
      // The words for the counts the service reports. A run that skipped
      // every sentence warns rather than congratulates.
      notice: draftNotice,
    },
  });

  const compare = useServiceRun({
    request,
    task: COMPARE_SPOT.key,
    storageId: COMPARE_STORAGE_ID,
    project,
    projectId,
    doc,
    acquireWriteLock,
    // The run's name, which CompareEditor's heldBy reads back.
    label: t('Compare'),
    timeout: COMPARE_SILENCE_MS,
    args: requestArgs,
    copy: {
      successTitle: t('Compared'),
      successMessage: t('The comparison finished.'),
      errorTitle: t('Failed to compare'),
      errorMessage: t('The comparison did not run.'),
      stoppedTitle: t('Compare'),
      // Said while the document is as it was: a stopped run that changed it
      // says so instead (plaid-ui useServiceRequest).
      stoppedMessage: t('No report was written.'),
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
