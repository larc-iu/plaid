import { useEffect, useCallback, useRef, useState } from 'react';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useServiceRequest } from '../../documents/hooks/useServiceRequest.js';

// Matches the old Mantine useHotkeys default: ignore key events from form fields.
const TAGS_TO_IGNORE = ['INPUT', 'TEXTAREA', 'SELECT'];

// Media tab operations, backed by the shared IgtDocument. This hook OWNS all
// transient media UI state (playback position, selection, popover, ASR options)
// as local React state, and delegates every mutation to the domain model
// (doc.uploadMedia/deleteMedia/clearAlignments/etc., all _withSaving-wrapped so
// they single-flight + toast + reload-on-error). The returned object is the
// single source the timeline + player read from.
export const useMediaOperations = () => {
  const { doc } = useDocumentCtx();
  useIgtDocument(doc);

  const project = doc.project;

  // Refs for RAF and monitoring
  const selectionMonitorRef = useRef(null);
  const mediaElementRef = useRef(null);
  const autoScrollToTimeRef = useRef(null);

  // Local media UI state (formerly ui.media.* on the valtio proxy)
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [selection, setSelection] = useState(null);
  const [playingSelection, setPlayingSelection] = useState(null);
  const [popoverOpened, setPopoverOpened] = useState(false);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(25);
  const [asrAlgorithm, setAsrAlgorithm] = useState('');
  const [asrAlgorithmOptions, setAsrAlgorithmOptions] = useState([]);
  const [transcriptionProgress, setTranscriptionProgress] = useState(0);
  const [currentOperation, setCurrentOperation] = useState('');
  const [isUploading, setIsUploading] = useState(false);

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

  const authenticatedMediaUrl = getAuthenticatedMediaUrl(doc.document.mediaUrl);

  // Get alignment token layer and tokens
  const alignmentTokenLayer = doc.layerInfo.alignmentTokenLayer;
  const alignmentTokens = doc.alignmentTokens || [];

  // Media playback operations
  const setMediaElement = useCallback((element) => {
    mediaElementRef.current = element;
  }, []);

  const setAutoScrollToTime = useCallback((fn) => {
    autoScrollToTimeRef.current = fn;
  }, []);

  const handleTimeUpdate = useCallback((time) => {
    setCurrentTime(time);
  }, []);

  const handleDurationChange = useCallback((d) => {
    setDuration(d);
  }, []);

  const handlePlayingChange = useCallback((playing) => {
    setIsPlaying(playing);
  }, []);

  const handleVolumeChange = useCallback((v) => {
    setVolume(v);
  }, []);

  const handleSeek = useCallback((time) => {
    setPlayingSelection(null); // Clear any playing selection
    // Auto-scroll timeline to show the seek position
    if (autoScrollToTimeRef.current) {
      autoScrollToTimeRef.current(time);
    }
  }, []);

  const handleSkipToBeginning = useCallback(() => {
    if (mediaElementRef.current) {
      mediaElementRef.current.pause();
      mediaElementRef.current.currentTime = 0;
      setCurrentTime(0);
      setPlayingSelection(null);
      // Auto-scroll timeline to beginning
      if (autoScrollToTimeRef.current) {
        autoScrollToTimeRef.current(0);
      }
    }
  }, []);

  const handleSkipToEnd = useCallback(() => {
    if (mediaElementRef.current && duration) {
      mediaElementRef.current.pause();
      mediaElementRef.current.currentTime = duration;
      setCurrentTime(duration);
      setPlayingSelection(null);
      // Auto-scroll timeline to end
      if (autoScrollToTimeRef.current) {
        autoScrollToTimeRef.current(duration);
      }
    }
  }, [duration]);

  const handlePlaySelection = useCallback(() => {
    if (selection && mediaElementRef.current) {
      mediaElementRef.current.currentTime = selection.start;
      setPlayingSelection(selection);

      // Wait for seek to complete before starting playback
      const handleSeeked = () => {
        mediaElementRef.current.removeEventListener('seeked', handleSeeked);
        mediaElementRef.current.play();
      };

      mediaElementRef.current.addEventListener('seeked', handleSeeked);
    }
  }, [selection]);

  const handleClearSelection = useCallback(() => {
    setSelection(null);
    setPopoverOpened(false);
  }, []);

  // Media upload operations
  const handleMediaUpload = useCallback(async (file) => {
    if (!file) return;

    setIsUploading(true);
    const ok = await doc.uploadMedia(file);
    setIsUploading(false);
    if (ok) {
      notifySuccess('Media file uploaded successfully', 'Success');
    }
  }, [doc]);

  const handleDeleteMedia = useCallback(async () => {
    if (!doc.document.id) return;

    if (!confirm('Are you sure you want to delete this media file? This action cannot be undone.')) {
      return;
    }

    const ok = await doc.deleteMedia();
    if (ok) {
      notifySuccess('Media file has been deleted successfully', 'Media Deleted');
    }
  }, [doc]);

  // ASR operations
  const handleAsrDropdownInteraction = useCallback(async () => {
    if (!project.id || isDiscovering) return;
    await discoverServices(project.id);
  }, [project.id, discoverServices, isDiscovering]);

  const updateProgress = useCallback((percent, operation) => {
    setTranscriptionProgress(percent);
    setCurrentOperation(operation);
  }, []);

  const handleTranscribe = useCallback(async () => {
    if (!asrAlgorithm.startsWith('service:')) return;

    const serviceId = asrAlgorithm.substring(8); // Remove 'service:' prefix
    const documentId = doc.document.id;

    if (!documentId) {
      notifyError('Document ID not found', 'Error');
      return;
    }

    // Find text, alignment token, and sentence token layers
    const primaryTextLayer = doc.layerInfo.primaryTextLayer;
    const alignmentTokenLayer = doc.layerInfo.alignmentTokenLayer;
    const sentenceTokenLayer = doc.layerInfo.sentenceTokenLayer;

    try {
      updateProgress(10, 'Starting transcription...');

      await requestService(
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

      // Note: For ASR transcription, we reload since it creates many alignment
      // tokens and the service response doesn't include the created token data.
      await doc._reload();

    } catch (error) {
      console.error('Transcription failed:', error);
      updateProgress(0, '');
    }
  }, [asrAlgorithm, doc, project, requestService, updateProgress]);

  const handleClearAlignments = useCallback(async () => {
    if (!alignmentTokens.length) return;

    if (!confirm('Are you sure you want to clear all time alignments? This action cannot be undone.')) {
      return;
    }

    updateProgress(25, 'Clearing alignments...');
    const count = alignmentTokens.length;
    const ok = await doc.clearAlignments();
    updateProgress(100, 'Alignments cleared!');
    if (ok) {
      notifySuccess(`Cleared ${count} time alignments`, 'Success');
    }
    setTranscriptionProgress(0);
    setCurrentOperation('');
  }, [alignmentTokens, doc, updateProgress]);

  const handleAlgorithmChange = useCallback((value) => {
    setAsrAlgorithm(value);
    // Cache the selection
    if (value) {
      localStorage.setItem('plaid_asr_algorithm', value);
    } else {
      localStorage.removeItem('plaid_asr_algorithm');
    }
  }, []);

  // Setup hotkeys (replaces Mantine useHotkeys; ignores events from form fields).
  useEffect(() => {
    const onKeyDown = (e) => {
      if (TAGS_TO_IGNORE.includes(e.target?.tagName)) return;
      // ESC key to clear selection
      if (e.key === 'Escape') {
        if (selection) {
          setSelection(null);
          setPopoverOpened(false);
        }
      } else if (e.key === ' ' && e.ctrlKey) {
        // Ctrl+Space to play selection
        e.preventDefault();
        if (selection && mediaElementRef.current) {
          handlePlaySelection();
        }
      } else if (e.key === ' ') {
        // Space key to toggle playback
        e.preventDefault();
        if (mediaElementRef.current) {
          if (isPlaying) {
            mediaElementRef.current.pause();
          } else {
            mediaElementRef.current.play();
          }
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selection, isPlaying, handlePlaySelection]);

  // Monitor selection playback and auto-pause at end
  useEffect(() => {
    const monitorSelection = () => {
      if (playingSelection && mediaElementRef.current && isPlaying) {
        const t = mediaElementRef.current.currentTime;
        if (t >= playingSelection.end) {
          // Reached end of selection, snap to exact end and pause
          mediaElementRef.current.currentTime = playingSelection.end;
          mediaElementRef.current.pause();
          setPlayingSelection(null);
          return; // Stop monitoring
        }
      }

      if (playingSelection && isPlaying) {
        selectionMonitorRef.current = requestAnimationFrame(monitorSelection);
      }
    };

    if (playingSelection && isPlaying) {
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
  }, [playingSelection, isPlaying]);

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

    setAsrAlgorithmOptions(options);
  }, [availableServices]);

  // Restore cached selection when options are available
  useEffect(() => {
    if (asrAlgorithmOptions.length === 0) {
      return;
    }

    const cached = localStorage.getItem('plaid_asr_algorithm');

    if (cached) {
      const isAvailable = asrAlgorithmOptions.some(opt => opt.value === cached);

      if (isAvailable) {
        // Cached selection is available, restore it
        setAsrAlgorithm(cached);
      } else {
        // Cached selection no longer available, clear it
        setAsrAlgorithm('');
        localStorage.removeItem('plaid_asr_algorithm');
      }
    }
  }, [asrAlgorithmOptions]);

  // Check if using ASR service
  const isUsingAsrService = asrAlgorithm && asrAlgorithm.startsWith('service:');

  return {
    // Shared model
    doc,

    // State
    document: doc.document,
    project,
    authenticatedMediaUrl,
    alignmentTokenLayer,
    alignmentTokens,

    // Media state
    currentTime,
    setCurrentTime,
    duration,
    isPlaying,
    volume,
    selection,
    setSelection,
    playingSelection,
    setPlayingSelection,
    popoverOpened,
    setPopoverOpened,
    pixelsPerSecond,
    setPixelsPerSecond,

    // ASR state
    asrAlgorithm,
    asrAlgorithmOptions,
    transcriptionProgress,
    currentOperation,
    isUsingAsrService,
    isProcessing,
    progressPercent,
    progressMessage,

    // Upload state
    isUploading,

    // Media operations
    setMediaElement,
    setAutoScrollToTime,
    handleTimeUpdate,
    handleDurationChange,
    handlePlayingChange,
    handleVolumeChange,
    handleSeek,
    handleSkipToBeginning,
    handleSkipToEnd,
    handlePlaySelection,
    handleClearSelection,

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
