import { useState, useCallback } from 'react';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useStrictClient } from '../contexts/StrictModeContext.jsx';

export const useServiceRequest = () => {
  const [availableServices, setAvailableServices] = useState([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStatus, setProcessStatus] = useState(null);
  const [processError, setProcessError] = useState(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  
  const client = useStrictClient();

  // Discover available services
  const discoverServices = useCallback(async (projectId) => {
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
  }, [client]);

  // Generic service request function with progress tracking
  const requestService = useCallback(async (projectId, documentId, serviceId, serviceParams, options = {}) => {
    if (!projectId || !documentId || !serviceId || isProcessing) return;

    const {
      successTitle = 'Service Complete',
      successMessage = 'Service request completed successfully',
      errorTitle = 'Service Failed', 
      errorMessage = 'An error occurred during service request',
      timeout = 300000
    } = options;

    let progressConnection = null;
    try {
      setProcessStatus('started');
      setProcessError(null);
      setIsProcessing(true);
      setProgressPercent(0);
      setProgressMessage('Starting service...');

      // Set up progress listener before making the request
      progressConnection = client.messages.listen(projectId, (eventType, eventData) => {
        if (eventType === 'message' && eventData.data?.type === 'service_response') {
          const message = eventData.data;
          if (message.status === 'progress') {
            setProgressPercent(message.progress?.percent || 0);
            setProgressMessage(message.progress?.message || '');
          }
        }
      });
      
      // Make the actual service request using the existing client method
      const result = await client.messages.requestService(
        projectId,
        serviceId,
        serviceParams,
        timeout
      );

      setProcessStatus('success');
      setProgressPercent(100);
      setProgressMessage('Completed successfully');
      
      notifySuccess(successMessage, successTitle);

      return result;
      
    } catch (error) {
      console.error('Failed to request service:', error);
      setProcessError(error.message || errorMessage);
      setProcessStatus('error');
      setProgressMessage(`Error: ${error.message || errorMessage}`);
      
      notifyError(error.message || errorMessage, errorTitle);

      throw error;
    } finally {
      // Always close the progress listener — on the success path AND when the
      // request throws (previously leaked the SSE listener on failure).
      if (progressConnection) {
        try { progressConnection.close(); } catch { /* already closed */ }
      }
      setIsProcessing(false);
    }
  }, [client, isProcessing]);

  // Clear processing status
  const clearProcessStatus = useCallback(() => {
    setProcessStatus(null);
    setProcessError(null);
    setProgressPercent(0);
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
    clearProcessStatus,
    
    // Computed flags. Discovery also returns previously-seen OFFLINE services
    // (for the Services settings tab); only online ones can take work.
    hasServices: availableServices.some((s) => s.online !== false)
  };
};