import { useState, useCallback, useRef } from 'react';
import { notifySuccess, notifyError, notifyInfo, notifyWarning } from '../lib/notify.js';

// One service request, from discovery to result, with the progress contract
// every run in every app wears.
//
// The `client` comes in rather than out of a context: each app reaches its own
// (plaid-igt through a StrictMode-safe context, plaid-ud through its auth
// provider), and a package that picked one would only work in that app.
export const useServiceRequest = (client) => {
  const [availableServices, setAvailableServices] = useState([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStatus, setProcessStatus] = useState(null);
  const [processError, setProcessError] = useState(null);
  // null until the service says otherwise: "we don't know yet" is not 0%, and
  // a determinate bar pinned at 0 reads as a hang.
  const [progressPercent, setProgressPercent] = useState(null);
  const [progressMessage, setProgressMessage] = useState('');
  // The request in flight, so it can be cancelled or found again after a reload.
  const inFlight = useRef(null); // { projectId, requestId }
  // Re-entrancy guard for discovery, read at call time rather than captured.
  const discovering = useRef(false);

  // Discover available services
  const discoverServices = useCallback(
    async (projectId) => {
      if (!projectId || discovering.current) return;
      discovering.current = true;
      setIsDiscovering(true);

      try {
        const services = await client.messages.discoverServices(projectId);
        setAvailableServices(services);
        return services;
      } catch (error) {
        console.error('[ServiceDiscovery] Failed to discover services:', error);
        setAvailableServices([]);
        return [];
      } finally {
        discovering.current = false;
        setIsDiscovering(false);
      }
    },
    [client],
  );

  const applyProgress = useCallback((payload) => {
    const percent = payload?.percent;
    setProgressPercent(Number.isFinite(percent) ? percent : null);
    // Keep the last real message rather than blanking the line.
    if (payload?.message) setProgressMessage(payload.message);
  }, []);

  const begin = useCallback(() => {
    setProcessStatus('started');
    setProcessError(null);
    setIsProcessing(true);
    setProgressPercent(null);
    setProgressMessage('Starting the service…');
  }, []);

  // A stopped request comes back as a normal result carrying `stopped: true`
  // (the service was asked and agreed), so it is neither a success to
  // celebrate nor an error to report. It needs its own title as well as its
  // own words: telling someone who has just pressed Stop that "Tokenization
  // Complete. Stopped." reads as a contradiction. `stoppedTitle` is the run's
  // plain name, the way the banner and the run record already name it.
  const succeed = useCallback((result, copy) => {
    const stopped = result?.stopped === true;
    setProcessStatus(stopped ? 'stopped' : 'success');
    setProgressPercent(stopped ? null : 100);
    setProgressMessage(stopped ? 'Stopped.' : 'Finished.');
    if (stopped) {
      notifyInfo(copy.stoppedMessage, copy.stoppedTitle || copy.successTitle);
      return;
    }
    // A service reports a per-item failure in its counts rather than by
    // failing the request, so a run where every item was skipped still comes
    // back a success. A caller that can read the counts passes `notice`, and
    // what it returns replaces the fixed copy, warning where a fixed
    // "Finished" would have congratulated an untouched document.
    const notice = copy.notice?.(result);
    if (notice?.level === 'warning') notifyWarning(notice.message, notice.title);
    else if (notice) notifySuccess(notice.message, notice.title);
    else notifySuccess(copy.successMessage, copy.successTitle);
  }, []);

  // An error carrying `pending` means the client gave up waiting but the
  // REQUEST is still out there: the service goes on working and goes on
  // writing. Saying "it failed" would be false, and the caller must keep the
  // run record so a reload can rejoin it. A caller that keeps NO record (speech
  // detection) says so instead of promising a reload that finds nothing.
  const fail = useCallback((error, copy) => {
    if (error?.pending) {
      setProcessError('Lost contact with the service.');
      setProcessStatus('lost');
      setProgressMessage('Lost contact with the service.');
      notifyWarning(copy.lostMessage, copy.stoppedTitle || copy.errorTitle);
      return;
    }
    setProcessError(error.message || copy.errorMessage);
    setProcessStatus('error');
    setProgressMessage(`Error: ${error.message || copy.errorMessage}`);
    notifyError(error.message || copy.errorMessage, copy.errorTitle);
  }, []);

  // Generic service request with progress tracking.
  //
  // The id is MINTED here rather than learned from the server's `accepted`
  // event, so `onRequestId` can write it down before the request is even
  // submitted — otherwise a reload in that window loses the run for good.
  // Progress comes from the request's own stream: the old project-wide
  // `messages.listen` also delivered other people's service progress into
  // whichever dialog happened to be open.
  const requestService = useCallback(
    async (projectId, documentId, serviceId, serviceParams, options = {}) => {
      if (!projectId || !documentId || !serviceId || isProcessing) return;

      const {
        successTitle = 'Service Complete',
        successMessage = 'Service request completed successfully',
        errorTitle = 'Service Failed',
        errorMessage = 'An error occurred during service request',
        // The run's plain name, for the one message that is neither a success
        // nor a failure. Whatever a stopped run had already written is kept, so
        // a run that writes nothing (speech detection) says something else.
        stoppedTitle,
        stoppedMessage = 'Stopped. What it had already written stays.',
        // `(result) => {level, title, message}`, for a caller that can tell a
        // real success from a run that did nothing. See `succeed`.
        notice,
        // Said when the client gives up but the request has not: only true for
        // a run this page wrote down, which is what a reload looks for.
        lostMessage = 'Lost contact with the service. It is still running. Reload to pick it back up.',
        timeout = 300000,
        onRequestId,
      } = options;

      const requestId = crypto.randomUUID();
      inFlight.current = { projectId, requestId };
      onRequestId?.(requestId);

      try {
        begin();
        const result = await client.messages.requestService(
          projectId,
          serviceId,
          serviceParams,
          timeout,
          applyProgress,
          undefined,
          { requestId },
        );
        succeed(result, { successMessage, successTitle, stoppedTitle, stoppedMessage, notice });
        return result;
      } catch (error) {
        console.error('Failed to request service:', error);
        fail(error, { errorMessage, errorTitle, stoppedTitle, lostMessage });
        // Said out loud already, so a caller's own catch does not say it again.
        if (error && typeof error === 'object') error.reported = true;
        throw error;
      } finally {
        inFlight.current = null;
        setIsProcessing(false);
      }
    },
    [client, isProcessing, begin, succeed, fail, applyProgress],
  );

  // Rejoin a request made earlier — by this page before a reload, or by this
  // user in another tab. The server replays the latest progress and then
  // delivers the result, or the stored result at once if it already finished.
  // A 404 means it is gone (unknown, or finished and collected), which is not
  // an error worth showing: the caller just forgets it.
  const attachToRequest = useCallback(
    async (projectId, requestId, { timeout = 20 * 60 * 1000 } = {}) => {
      inFlight.current = { projectId, requestId };
      try {
        begin();
        return await client.messages.attachServiceRequest(
          projectId,
          requestId,
          timeout,
          applyProgress,
        );
      } finally {
        inFlight.current = null;
        setIsProcessing(false);
      }
    },
    [client, begin, applyProgress],
  );

  // Ask the service to stop. The request still ends with whatever the service
  // reports next, which arrives on the stream we are already awaiting, so the
  // caller's own finally-block is what tidies up.
  const cancelRequest = useCallback(async () => {
    const current = inFlight.current;
    if (!current) return false;
    try {
      await client.messages.cancelServiceRequest(current.projectId, current.requestId);
      setProgressMessage('Stopping…');
      return true;
    } catch (error) {
      // 409 once finished, 404 if it was never there: either way there is
      // nothing left to stop.
      console.warn('Could not cancel the service request:', error);
      return false;
    }
  }, [client]);

  // Clear processing status
  const clearProcessStatus = useCallback(() => {
    setProcessStatus(null);
    setProcessError(null);
    setProgressPercent(null);
    setProgressMessage('');
  }, []);

  return {
    // Service discovery
    availableServices,
    isDiscovering,
    discoverServices,

    // Processing status
    isProcessing,
    processStatus,
    processError,
    progressPercent,
    progressMessage,

    // Actions
    requestService,
    attachToRequest,
    cancelRequest,
    clearProcessStatus,

    // Computed flags. Discovery also returns previously-seen OFFLINE services
    // (for the Services settings tab); only online ones can take work.
    hasServices: availableServices.some((s) => s.online !== false),
  };
};
