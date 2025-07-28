import { useEffect, useCallback, useRef } from 'react';
import { useSnapshot } from 'valtio';
import { useHotkeys } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useStrictModeErrorHandler } from '../hooks/useStrictModeErrorHandler.js';
import { useServiceRequest } from '../../documents/hooks/useServiceRequest.js';
import documentsStore from '../../../stores/documentsStore.js';

export const useMediaOperations = (projectId, documentId, reload, client) => {
  const handleError = useStrictModeErrorHandler(reload);
  
  // Get the document snapshot and proxy
  const docSnap = useSnapshot(documentsStore[projectId][documentId]);
  const docProxy = documentsStore[projectId][documentId];
  const uiProxy = docProxy.ui.media;
  const uiSnap = docSnap.ui.media;
  
  const document = docSnap.document;
  const project = docSnap.project;
  const parsedDocument = docSnap;
  
  // Refs for RAF and monitoring
  const selectionMonitorRef = useRef(null);
  const mediaElementRef = useRef(null);
  
  // ASR service hook
  const {
    availableServices,
    isDiscovering,
    discoverServices,
    isProcessing,
    requestService,
    hasServices,
    progressPercent,
    progressMessage
  } = useServiceRequest();

  // Get authenticated media URL with proper base path handling
  const getAuthenticatedMediaUrl = (serverUrl) => {
    if (!serverUrl) return serverUrl;
    return `${serverUrl}?token=${localStorage.getItem('token')}`;
  };

  const authenticatedMediaUrl = getAuthenticatedMediaUrl(parsedDocument.document.mediaUrl);

  // Get alignment token layer and tokens
  const alignmentTokenLayer = parsedDocument.layers.alignmentTokenLayer;
  const alignmentTokens = parsedDocument.alignmentTokens || [];

  // Media playback operations
  const setMediaElement = useCallback((element) => {
    mediaElementRef.current = element;
  }, []);

  const handleTimeUpdate = useCallback((time) => {
    uiProxy.currentTime = time;
  }, [uiProxy]);

  const handleDurationChange = useCallback((duration) => {
    uiProxy.duration = duration;
  }, [uiProxy]);

  const handlePlayingChange = useCallback((isPlaying) => {
    uiProxy.isPlaying = isPlaying;
  }, [uiProxy]);

  const handleVolumeChange = useCallback((volume) => {
    uiProxy.volume = volume;
  }, [uiProxy]);

  const handleSeek = useCallback((time) => {
    uiProxy.playingSelection = null; // Clear any playing selection
    // Auto-scroll timeline will be handled by timeline operations
  }, [uiProxy]);

  const handleSkipToBeginning = useCallback(() => {
    if (mediaElementRef.current) {
      mediaElementRef.current.pause();
      mediaElementRef.current.currentTime = 0;
      uiProxy.currentTime = 0;
      uiProxy.playingSelection = null;
    }
  }, [uiProxy]);

  const handleSkipToEnd = useCallback(() => {
    if (mediaElementRef.current && uiSnap.duration) {
      mediaElementRef.current.pause();
      mediaElementRef.current.currentTime = uiSnap.duration;
      uiProxy.currentTime = uiSnap.duration;
      uiProxy.playingSelection = null;
    }
  }, [uiProxy, uiSnap.duration]);

  const handlePlaySelection = useCallback(() => {
    if (uiSnap.selection && mediaElementRef.current) {
      mediaElementRef.current.currentTime = uiSnap.selection.start;
      uiProxy.playingSelection = uiSnap.selection;
      
      // Wait for seek to complete before starting playback
      const handleSeeked = () => {
        mediaElementRef.current.removeEventListener('seeked', handleSeeked);
        mediaElementRef.current.play();
      };
      
      mediaElementRef.current.addEventListener('seeked', handleSeeked);
    }
  }, [uiSnap.selection, uiProxy]);

  const handleClearSelection = useCallback(() => {
    uiProxy.selection = null;
    uiProxy.popoverOpened = false;
  }, [uiProxy]);

  const setPopoverOpened = useCallback((opened) => {
    uiProxy.popoverOpened = opened;
  }, [uiProxy]);

  // Media upload operations
  const handleMediaUpload = useCallback(async (file) => {
    if (!file) return;

    try {
      uiProxy.isUploading = true;
      await client.documents.uploadMedia(parsedDocument.document.id, file);
      
      notifications.show({
        title: 'Success',
        message: 'Media file uploaded successfully',
        color: 'green'
      });
      
      // Reload to get updated document state
      if (reload) {
        reload();
      }
    } catch (error) {
      handleError(error, 'upload media file');
    } finally {
      uiProxy.isUploading = false;
    }
  }, [client, parsedDocument, handleError, uiProxy, reload]);

  const handleDeleteMedia = useCallback(async () => {
    if (!parsedDocument.document.id || !client) return;

    if (!confirm('Are you sure you want to delete this media file? This action cannot be undone.')) {
      return;
    }

    try {
      await client.documents.deleteMedia(parsedDocument.document.id);
      
      notifications.show({
        title: 'Media Deleted',
        message: 'Media file has been deleted successfully',
        color: 'green'
      });
      
      // Reload to get updated document state
      if (reload) {
        reload();
      }
    } catch (error) {
      handleError(error, 'delete media file');
    }
  }, [client, parsedDocument, handleError, reload]);

  // ASR operations
  const handleAsrDropdownInteraction = useCallback(async () => {
    if (!project.id || isDiscovering) return;
    await discoverServices(project.id);
  }, [project.id, discoverServices]);

  const updateProgress = useCallback((percent, operation) => {
    uiProxy.transcriptionProgress = percent;
    uiProxy.currentOperation = operation;
  }, [uiProxy]);

  const handleTranscribe = useCallback(async () => {
    if (!uiSnap.asrAlgorithm.startsWith('service:')) return;
    
    const serviceId = uiSnap.asrAlgorithm.substring(8); // Remove 'service:' prefix
    const documentId = parsedDocument.document.id;
    
    if (!documentId) {
      notifications.show({
        title: 'Error',
        message: 'Document ID not found',
        color: 'red'
      });
      return;
    }
    
    // Find text, alignment token, and sentence token layers
    const primaryTextLayer = parsedDocument.layers.primaryTextLayer;
    const alignmentTokenLayer = parsedDocument.layers.alignmentTokenLayer;
    const sentenceTokenLayer = parsedDocument.layers.sentenceTokenLayer;

    try {
      updateProgress(10, 'Starting transcription...');
      
      const result = await requestService(
        project.id,
        documentId,
        serviceId,
        {
          documentId: documentId,
          textLayerId: primaryTextLayer.id,
          alignmentTokenLayerId: alignmentTokenLayer.id,
          sentenceTokenLayerId: sentenceTokenLayer.id,
        },
        {
          successTitle: 'Transcription Complete',
          successMessage: 'Audio has been transcribed successfully',
          errorTitle: 'Transcription Failed',
          errorMessage: 'An error occurred during transcription'
        }
      );
      
      updateProgress(100, 'Transcription complete!');
      
      // Note: For ASR transcription, we keep the reload since it creates many alignment tokens
      // and the service response doesn't include the created token data needed for optimistic updates
      if (reload) {
        reload();
      }
      
    } catch (error) {
      console.error('Transcription failed:', error);
      updateProgress(0, '');
    }
  }, [uiSnap.asrAlgorithm, parsedDocument, project, requestService, updateProgress, reload]);

  const handleClearAlignments = useCallback(async () => {
    if (!alignmentTokens.length) return;
    
    if (!confirm('Are you sure you want to clear all time alignments? This action cannot be undone.')) {
      return;
    }
    
    try {
      updateProgress(25, 'Clearing alignments...');
      
      // Delete all alignment tokens
      const alignmentIds = alignmentTokens.map(token => token.id);
      await client.tokens.bulkDelete(alignmentIds);
      
      updateProgress(100, 'Alignments cleared!');
      
      notifications.show({
        title: 'Success',
        message: `Cleared ${alignmentIds.length} time alignments`,
        color: 'green'
      });
      
      // Reload to get updated document state
      if (reload) {
        reload();
      }
      
    } catch (error) {
      handleError(error, 'clear alignments');
    } finally {
      uiProxy.transcriptionProgress = 0;
      uiProxy.currentOperation = '';
    }
  }, [alignmentTokens, client, handleError, reload, updateProgress, uiProxy]);

  const handleAlgorithmChange = useCallback((value) => {
    uiProxy.asrAlgorithm = value;
    // Cache the selection
    if (value) {
      localStorage.setItem('plaid_asr_algorithm', value);
    } else {
      localStorage.removeItem('plaid_asr_algorithm');
    }
  }, [uiProxy]);

  // Setup hotkeys
  useHotkeys([
    // ESC key to clear selection
    ['Escape', () => {
      if (uiSnap.selection) {
        uiProxy.selection = null;
        uiProxy.popoverOpened = false;
      }
    }],
    
    // Space key to toggle playback
    ['space', () => {
      if (mediaElementRef.current) {
        if (uiSnap.isPlaying) {
          mediaElementRef.current.pause();
        } else {
          mediaElementRef.current.play();
        }
      }
    }],
    
    // Ctrl+Space to play selection
    ['ctrl+space', () => {
      if (uiSnap.selection && mediaElementRef.current) {
        handlePlaySelection();
      }
    }]
  ]);

  // Monitor selection playback and auto-pause at end
  useEffect(() => {
    const monitorSelection = () => {
      if (uiSnap.playingSelection && mediaElementRef.current && uiSnap.isPlaying) {
        const currentTime = mediaElementRef.current.currentTime;
        if (currentTime >= uiSnap.playingSelection.end) {
          // Reached end of selection, snap to exact end and pause
          mediaElementRef.current.currentTime = uiSnap.playingSelection.end;
          mediaElementRef.current.pause();
          uiProxy.playingSelection = null;
          return; // Stop monitoring
        }
      }
      
      if (uiSnap.playingSelection && uiSnap.isPlaying) {
        selectionMonitorRef.current = requestAnimationFrame(monitorSelection);
      }
    };

    if (uiSnap.playingSelection && uiSnap.isPlaying) {
      selectionMonitorRef.current = requestAnimationFrame(monitorSelection);
    } else {
      if (selectionMonitorRef.current) {
        cancelAnimationFrame(selectionMonitorRef.current);
        selectionMonitorRef.current = null;
      }
    }

    return () => {
      if (selectionMonitorRef.current) {
        cancelAnimationFrame(selectionMonitorRef.current);
        selectionMonitorRef.current = null;
      }
    };
  }, [uiSnap.playingSelection, uiSnap.isPlaying, uiProxy]);

  // Trigger service discovery on component mount
  useEffect(() => {
    if (project.id) {
      discoverServices(project.id);
    }
  }, [project.id, discoverServices]);

  // Populate ASR options when available services change
  useEffect(() => {
    // Build options list with discovered ASR services
    const options = [];
    
    // Add discovered ASR services (filter by asr: prefix)
    availableServices.forEach(service => {
      if (service.serviceId.startsWith('asr:')) {
        options.push({
          value: `service:${service.serviceId}`,
          label: service.serviceName
        });
      }
    });
    
    uiProxy.asrAlgorithmOptions = options;
  }, [availableServices, uiProxy]);

  // Restore cached selection when options are available
  useEffect(() => {
    if (uiSnap.asrAlgorithmOptions.length === 0) {
      return;
    }
    
    const cached = localStorage.getItem('plaid_asr_algorithm');
    
    if (cached) {
      const isAvailable = uiSnap.asrAlgorithmOptions.some(opt => opt.value === cached);
      
      if (isAvailable) {
        // Cached selection is available, restore it
        uiProxy.asrAlgorithm = cached;
      } else {
        // Cached selection no longer available, clear it
        uiProxy.asrAlgorithm = '';
        localStorage.removeItem('plaid_asr_algorithm');
      }
    }
  }, [uiSnap.asrAlgorithmOptions, uiProxy]);

  // Check if using ASR service
  const isUsingAsrService = uiSnap.asrAlgorithm && uiSnap.asrAlgorithm.startsWith('service:');

  return {
    // State
    document,
    project,
    parsedDocument,
    authenticatedMediaUrl,
    alignmentTokenLayer,
    alignmentTokens,
    
    // Media state
    currentTime: uiSnap.currentTime,
    duration: uiSnap.duration,
    isPlaying: uiSnap.isPlaying,
    volume: uiSnap.volume,
    selection: uiSnap.selection,
    playingSelection: uiSnap.playingSelection,
    popoverOpened: uiSnap.popoverOpened,
    
    // ASR state
    asrAlgorithm: uiSnap.asrAlgorithm,
    asrAlgorithmOptions: uiSnap.asrAlgorithmOptions,
    transcriptionProgress: uiSnap.transcriptionProgress,
    currentOperation: uiSnap.currentOperation,
    isUsingAsrService,
    isProcessing,
    progressPercent,
    progressMessage,
    
    // Upload state
    isUploading: uiSnap.isUploading,
    
    // Media operations
    setMediaElement,
    handleTimeUpdate,
    handleDurationChange,
    handlePlayingChange,
    handleVolumeChange,
    handleSeek,
    handleSkipToBeginning,
    handleSkipToEnd,
    handlePlaySelection,
    handleClearSelection,
    setPopoverOpened,
    
    // Media file operations
    handleMediaUpload,
    handleDeleteMedia,
    
    // ASR operations
    handleAsrDropdownInteraction,
    handleTranscribe,
    handleClearAlignments,
    handleAlgorithmChange,
    
    // Service discovery
    discoverServices,
    isDiscovering,
    availableServices,
    hasServices,
    
    // Refs
    mediaElementRef
  };
};