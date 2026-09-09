import { useState, useCallback, useRef } from 'react';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useStrictClient } from '../contexts/StrictModeContext.jsx';

export const useServiceRequest = () => {
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

  const client = useStrictClient();

  // Discover available services
  const discoverServices = useCallback(
    async (projectId) => {
      if (!projectId || isDiscovering) return;

      console.log(`[ServiceDiscovery] Starting service discovery for project ${projectId}`);
      setIsDiscovering(true);

      try {
        const services = await client.messages.discoverServices(projectId);
        console.log(`[ServiceDiscovery] Found ${services.length} services:`, services);
        setAvailableServices(services);
        return services;
      } catch (error) {
        console.error('[ServiceDiscovery] Failed to discover services:', error);
        setAvailableServices([]);
        return [];
      } finally {
        setIsDiscovering(false);
        console.log(`[ServiceDiscovery] Discovery complete`);
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

  const succeed = useCallback((successMessage, successTitle) => {
    setProcessStatus('success');
    setProgressPercent(100);
    setProgressMessage('Finished.');
    notifySuccess(successMessage, successTitle);
  }, []);

  const fail = useCallback((error, errorMessage, errorTitle) => {
    setProcessError(error.message || errorMessage);
    setProcessStatus('error');
    setProgressMessage(`Error: ${error.message || errorMessage}`);
    notifyError(error.message || errorMessage, errorTitle);
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
        succeed(successMessage, successTitle);
        return result;
      } catch (error) {
        console.error('Failed to request service:', error);
        fail(error, errorMessage, errorTitle);
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
