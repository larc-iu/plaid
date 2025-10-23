import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';

export const useNlpService = (projectId, documentId) => {
  const [availableServices, setAvailableServices] = useState([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState(null); // 'started', 'success', 'error'
  const [parseError, setParseError] = useState(null);
  
  const { getClient } = useAuth();


  // Discover available NLP services
  const discoverServices = useCallback(async () => {
    if (!projectId || isDiscovering) return;

    const client = getClient();
    if (!client) return;

    setIsDiscovering(true);
    
    try {
      console.log('Starting service discovery for project:', projectId);
      const services = await client.messages.discoverServices(projectId, 3000);
      console.log('Discovered services:', services);
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
      setParseError('No NLP services available');
      return;
    }

    try {
      setParseStatus('started');
      setParseError(null);
      setIsParsing(true);
      
      console.log('Sending service request with documentId:', documentId);
      const result = await client.messages.requestService(
        projectId,
        nlpService.serviceId,
        { documentId },
        30000  // 30 second timeout
      );
      
      console.log('Parse result:', result);
      setParseStatus('success');
      setIsParsing(false);
      
    } catch (error) {
      console.error('Failed to request parse:', error);
      setParseError(error.message || 'Failed to parse document');
      setParseStatus('error');
      setIsParsing(false);
    }
  }, [projectId, documentId, availableServices, getClient]);

  // Clear parse status
  const clearParseStatus = useCallback(() => {
    setParseStatus(null);
    setParseError(null);
  }, []);

  // Discover services when component mounts or projectId changes
  useEffect(() => {
    if (projectId) {
      discoverServices();
    }
  }, [projectId, discoverServices]);

  return {
    // Service discovery
    availableServices,
    isDiscovering,
    
    // Status flags
    isParsing,
    
    // Parse status
    parseStatus,
    parseError,
    
    // Actions
    discoverServices,
    requestParse,
    clearParseStatus,
    
    // Computed flags
    canParse: availableServices.length > 0 && !isParsing,
    hasParseResult: parseStatus === 'success' || parseStatus === 'error',
    hasServices: availableServices.length > 0
  };
};