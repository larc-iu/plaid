import { useEffect, useCallback, useRef, useState } from 'react';
import { filterServicesByTask, TASKS } from '@larc-iu/plaid-client';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useServiceRequest } from '../../documents/hooks/useServiceRequest.js';
import { useServiceParams } from '../../documents/hooks/useServiceParams.js';
import {
  encodeServiceSelection, readSpotDefault, resolveInitialSelection,
} from '../../../domain/serviceDefaults.js';

// Matches the old Mantine useHotkeys default: ignore key events from form fields.
const TAGS_TO_IGNORE = ['INPUT', 'TEXTAREA', 'SELECT'];

const SERVICE_KEY = 'plaid_igt_transcribe_service';
const PARAMS_PREFIX = 'plaid_igt_transcribe_params_';

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
  // Always-current mirror of `volume` so the (deps-`[]`) media-element
  // registration callback can apply the latest value without a stale closure.
  const volumeRef = useRef(0.8);
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

  // The selected ASR service (null for none) and its user-controllable
  // arguments. Defined before handleTranscribe so it can merge the args.
  const selectedServiceId = asrAlgorithm.startsWith('service:') ? asrAlgorithm.slice(8) : null;
  const selectedService = selectedServiceId
    ? availableServices.find((s) => s.serviceId === selectedServiceId) || null
    : null;
  const transcribeDefault = readSpotDefault(project, TASKS.TRANSCRIBE);
  const { schema: paramSchema, values: paramValues, setParam: setParamValue, coerced: coerceParams, errors: paramErrors } =
    useServiceParams(selectedService, PARAMS_PREFIX,
      transcribeDefault?.service?.serviceId === selectedServiceId ? transcribeDefault?.params : null);

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
    // Apply the current volume to a freshly-registered element. This covers the
    // element mounting after the initial 0.8 (or a later value) was set, since
    // the `[volume]` effect below won't re-run just because the ref changed.
    if (element) element.volume = volumeRef.current;
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
    // Apply immediately to the DOM media element (state alone never reaches it).
    if (mediaElementRef.current) mediaElementRef.current.volume = v;
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

    // Block on unmet required service arguments before doing any work.
    const missing = Object.values(paramErrors);
    if (missing.length) {
      notifyError(missing[0], 'Missing required option');
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
          // User-controlled arguments declared by the service, spread FIRST so
          // the fixed layer/doc params below always win over any same-named arg.
          ...coerceParams(),
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
  }, [asrAlgorithm, doc, project, requestService, updateProgress, coerceParams, paramErrors]);

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
      localStorage.setItem(SERVICE_KEY, value);
    } else {
      localStorage.removeItem(SERVICE_KEY);
    }
  }, []);

  // Keep the DOM media element's volume in sync with `volume`. Covers the
  // initial 0.8, any volume set before the element mounted, and element swaps.
  useEffect(() => {
    volumeRef.current = volume;
    if (mediaElementRef.current) mediaElementRef.current.volume = volume;
  }, [volume]);

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

  // Populate ASR options when available services change. Services are matched
  // by their declared `tasks`; only ONLINE ones are offered (discovery also
  // returns previously-seen offline services).
  useEffect(() => {
    const options = filterServicesByTask(availableServices, TASKS.TRANSCRIBE)
      .filter((s) => s.online !== false)
      .map(service => ({
        value: encodeServiceSelection(service.serviceId),
        label: service.serviceName,
      }));
    setAsrAlgorithmOptions(options);
  }, [availableServices]);

  // Resolve the initial selection when options are available: cached choice ->
  // project default (config.igt.serviceDefaults.transcribe) -> first online.
  useEffect(() => {
    if (asrAlgorithmOptions.length === 0) {
      return;
    }
    const onlineServices = filterServicesByTask(availableServices, TASKS.TRANSCRIBE)
      .filter((s) => s.online !== false);
    setAsrAlgorithm((cur) => {
      if (cur && asrAlgorithmOptions.some((opt) => opt.value === cur)) return cur;
      return resolveInitialSelection({
        services: onlineServices,
        cached: localStorage.getItem(SERVICE_KEY),
        projectDefault: readSpotDefault(project, TASKS.TRANSCRIBE),
      }) || '';
    });
  }, [asrAlgorithmOptions, availableServices, project]);

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
    // selected-service args + summary
    selectedService,
    paramSchema,
    paramValues,
    setParamValue,
    paramErrors,

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
