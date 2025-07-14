import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';

export const useNlpService = (projectId, documentId) => {
  const [availableServices, setAvailableServices] = useState([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState(null); // 'started', 'success', 'error'
  const [parseError, setParseError] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'connected', 'connecting', 'disconnected'
  
  const { getClient } = useAuth();
  const connectionRef = useRef(null);
  const servicesRef = useRef([]);

  // Clean up connections
  const cleanup = useCallback(() => {
    if (connectionRef.current) {
      connectionRef.current.close();
      connectionRef.current = null;
    }
    setConnectionStatus('disconnected');
  }, []);

  // Start listening to project events
  const startListening = useCallback(() => {
    if (!projectId || connectionRef.current) return;

    const client = getClient();
    if (!client) return;

    try {
      setConnectionStatus('connecting');
      
      const connection = client.messages.listen(projectId, (eventType, eventData) => {
        // Handle service coordination messages and legacy string messages
        if (eventType === 'message') {
          const messageBody = eventData.data;
          
          // Handle legacy string messages for backward compatibility
          if (typeof messageBody === 'string') {
            if (messageBody.startsWith('parse-started:')) {
              const docId = messageBody.split(':', 2)[1];
              if (docId === documentId) {
                setIsParsing(true);
                setParseStatus('started');
                setParseError(null);
              }
            } else if (messageBody.startsWith('parse-success:')) {
              const docId = messageBody.split(':', 2)[1];
              if (docId === documentId) {
                setIsParsing(false);
                setParseStatus('success');
                setParseError(null);
              }
            } else if (messageBody.startsWith('parse-error:')) {
              const parts = messageBody.split(':', 3);
              const docId = parts[1];
              const error = parts[2] || 'Unknown error';
              if (docId === documentId) {
                setIsParsing(false);
                setParseStatus('error');
                setParseError(error);
              }
            }
          }
        }
      });

      connectionRef.current = connection;
      setConnectionStatus('connected');
      
    } catch (error) {
      console.error('Failed to start listening:', error);
      setConnectionStatus('disconnected');
    }
  }, [projectId, documentId, getClient]);

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
      servicesRef.current = services;
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

  // Initialize connection when component mounts or projectId changes
  useEffect(() => {
    if (projectId) {
      startListening();
      // Small delay before discovering services to ensure connection is established
      const timer = setTimeout(() => {
        discoverServices();
      }, 1000);
      return () => clearTimeout(timer);
    }
    return cleanup;
  }, [projectId, startListening, cleanup]); // Removed discoverServices from dependencies

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return {
    // Service discovery
    availableServices,
    isDiscovering,
    
    // Status flags
    isParsing,
    connectionStatus,
    
    // Parse status
    parseStatus,
    parseError,
    
    // Actions
    discoverServices,
    requestParse,
    clearParseStatus,
    
    // Computed flags
    canParse: availableServices.length > 0 && !isParsing && connectionStatus === 'connected',
    hasParseResult: parseStatus === 'success' || parseStatus === 'error',
    hasServices: availableServices.length > 0
  };
};