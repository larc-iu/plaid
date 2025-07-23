import { useState, useCallback } from 'react';
import { notifications } from '@mantine/notifications';
import { useStrictClient } from '../../../contexts/StrictModeContext';

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

    setIsDiscovering(true);
    
    try {
      const services = await client.messages.discoverServices(projectId, 1000);
      setAvailableServices(services);
      return services;
    } catch (error) {
      console.error('Failed to discover services:', error);
      setAvailableServices([]);
      return [];
    } finally {
      setIsDiscovering(false);
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

    try {
      setProcessStatus('started');
      setProcessError(null);
      setIsProcessing(true);
      setProgressPercent(0);
      setProgressMessage('Starting service...');
      
      // Set up progress listener before making the request
      const progressConnection = client.messages.listen(projectId, (eventType, eventData) => {
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
      
      // Clean up progress listener
      progressConnection.close();
      
      setProcessStatus('success');
      setProgressPercent(100);
      setProgressMessage('Completed successfully');
      
      notifications.show({
        title: successTitle,
        message: successMessage,
        color: 'green'
      });
      
      return result;
      
    } catch (error) {
      console.error('Failed to request service:', error);
      setProcessError(error.message || errorMessage);
      setProcessStatus('error');
      setProgressMessage(`Error: ${error.message || errorMessage}`);
      
      notifications.show({
        title: errorTitle,
        message: error.message || errorMessage,
        color: 'red'
      });
      
      throw error;
    } finally {
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
    
    // Computed flags
    hasServices: availableServices.length > 0
  };
};