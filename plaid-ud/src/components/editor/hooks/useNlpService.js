import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';
import { notifyError } from '../../../utils/feedback.jsx';

export const useNlpService = (projectId, documentId) => {
  const [availableServices, setAvailableServices] = useState([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState(null); // 'started', 'success', 'error'

  const { getClient } = useAuth();


  // Discover available NLP services
  const discoverServices = useCallback(async () => {
    if (!projectId || isDiscovering) return;

    const client = getClient();
    if (!client) return;

    setIsDiscovering(true);
    
    try {
      const services = await client.messages.discoverServices(projectId);
      setAvailableServices(services);
    } catch (error) {
      console.error('Failed to discover services:', error);
      setAvailableServices([]);
    } finally {
      setIsDiscovering(false);
    }
  }, [projectId, getClient]);

  // Request document parsing using structured service request
  const requestParse = useCallback(async () => {
    if (!projectId || !documentId || isParsing || availableServices.length === 0) return;

    const client = getClient();
    if (!client) return;

    // Use the first available NLP service
    const nlpService = availableServices[0];
    if (!nlpService) {
      notifyError('No NLP services available');
      return;
    }

    try {
      setParseStatus('started');
      setIsParsing(true);

      await client.messages.requestService(
        projectId,
        nlpService.serviceId,
        { documentId },
        30000  // 30 second timeout
      );
      
      setParseStatus('success');
      setIsParsing(false);
      
    } catch (error) {
      console.error('Failed to request parse:', error);
      notifyError(error.message || 'Failed to parse document', 'Parse Error');
      setParseStatus('error');
      setIsParsing(false);
    }
  }, [projectId, documentId, availableServices, getClient]);

  // Clear parse status
  const clearParseStatus = useCallback(() => {
    setParseStatus(null);
  }, []);

  // Discover services when component mounts or projectId changes
  useEffect(() => {
    if (projectId) {
      discoverServices();
    }
  }, [projectId, discoverServices]);

  return {
    // Status
    isDiscovering,
    isParsing,
    parseStatus,

    // Actions
    discoverServices,
    requestParse,
    clearParseStatus,

    // Computed flags
    canParse: availableServices.length > 0 && !isParsing,
    hasServices: availableServices.length > 0
  };
};