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
    label: 'Draft',
    timeout: DRAFT_SILENCE_MS,
    args: requestArgs,
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

  const compare = useServiceRun({
    request,
    task: COMPARE_SPOT.key,
    storageId: COMPARE_STORAGE_ID,
    project,
    projectId,
    doc,
    acquireWriteLock,
    label: 'Compare',
    timeout: COMPARE_SILENCE_MS,
    args: requestArgs,
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
