import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';

export const useNlpService = (projectId, documentId) => {
  const [isAwake, setIsAwake] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState(null); // 'started', 'success', 'error'
  const [parseError, setParseError] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'connected', 'connecting', 'disconnected'
  
  const { getClient } = useAuth();
  const connectionRef = useRef(null);
  const wakeCheckTimeoutRef = useRef(null);
  const hasInitialCheckRef = useRef(false);

  // Clean up timeouts and connections
  const cleanup = useCallback(() => {
    if (wakeCheckTimeoutRef.current) {
      clearTimeout(wakeCheckTimeoutRef.current);
      wakeCheckTimeoutRef.current = null;
    }
    if (connectionRef.current) {
      connectionRef.current.close();
      connectionRef.current = null;
    }
    hasInitialCheckRef.current = false;
  }, []);

  // Start listening to project events
  const startListening = useCallback(() => {
    if (!projectId || connectionRef.current) return;

    const client = getClient();
    if (!client) return;

    try {
      setConnectionStatus('connecting');
      
      const connection = client.messages.listen(projectId, (eventType, eventData) => {
        if (eventType === 'message') {
          const messageBody = eventData.data;
          
          if (messageBody === 'nlp-awake') {
            setIsAwake(true);
            setIsChecking(false);
            // Clear the timeout since we got a response
            if (wakeCheckTimeoutRef.current) {
              clearTimeout(wakeCheckTimeoutRef.current);
              wakeCheckTimeoutRef.current = null;
            }
          } else if (messageBody.startsWith('parse-started:')) {
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
      });

      connectionRef.current = connection;
      setConnectionStatus('connected');
      
    } catch (error) {
      console.error('Failed to start listening:', error);
      setConnectionStatus('disconnected');
    }
  }, [projectId, documentId, getClient]);

  // Check if NLP service is awake
  const checkIfAwake = useCallback(() => {
    if (!projectId || isChecking) return;

    const client = getClient();
    if (!client) return;

    hasInitialCheckRef.current = true; // Mark that we've done a check
    setIsChecking(true);
    setIsAwake(false);
    
    try {
      client.messages.sendMessage(projectId, 'nlp-wake-check');
      
      // Set timeout to mark as not awake if no response
      wakeCheckTimeoutRef.current = setTimeout(() => {
        setIsChecking(false);
        setIsAwake(false);
      }, 5000); // 5 second timeout
      
    } catch (error) {
      console.error('Failed to send wake check:', error);
      setIsChecking(false);
      setIsAwake(false);
    }
  }, [projectId, isChecking, getClient]);

  // Request document parsing
  const requestParse = useCallback(() => {
    if (!projectId || !documentId || isParsing || !isAwake) return;

    const client = getClient();
    if (!client) return;

    try {
      setParseStatus(null);
      setParseError(null);
      client.messages.sendMessage(projectId, `parse-document:${documentId}`);
    } catch (error) {
      console.error('Failed to request parse:', error);
      setParseError('Failed to send parse request');
    }
  }, [projectId, documentId, isParsing, isAwake, getClient]);

  // Clear parse status
  const clearParseStatus = useCallback(() => {
    setParseStatus(null);
    setParseError(null);
  }, []);

  // Initialize connection when component mounts or projectId changes
  useEffect(() => {
    if (projectId) {
      hasInitialCheckRef.current = false; // Reset for new project
      startListening();
      // Small delay before checking if awake to ensure connection is established
      const timer = setTimeout(() => {
        const client = getClient();
        if (client && !hasInitialCheckRef.current) {
          hasInitialCheckRef.current = true;
          setIsChecking(true);
          setIsAwake(false);
          
          try {
            client.messages.sendMessage(projectId, 'nlp-wake-check');
            
            // Set timeout to mark as not awake if no response
            wakeCheckTimeoutRef.current = setTimeout(() => {
              setIsChecking(false);
              setIsAwake(false);
            }, 5000);
          } catch (error) {
            console.error('Failed to send initial wake check:', error);
            setIsChecking(false);
            setIsAwake(false);
          }
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
    return cleanup;
  }, [projectId, startListening, cleanup, getClient]);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return {
    // Status flags
    isAwake,
    isChecking,
    isParsing,
    connectionStatus,
    
    // Parse status
    parseStatus,
    parseError,
    
    // Actions
    checkIfAwake,
    requestParse,
    clearParseStatus,
    
    // Computed flags
    canParse: isAwake && !isParsing && connectionStatus === 'connected',
    hasParseResult: parseStatus === 'success' || parseStatus === 'error'
  };
};