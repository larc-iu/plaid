import { useEffect, useCallback, useRef, useState } from 'react';
import { filterServicesByTask, TASKS } from '@larc-iu/plaid-client';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useServiceRequest } from '../../documents/hooks/useServiceRequest.js';
import { useServiceParams } from '../../documents/hooks/useServiceParams.js';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import {
  encodeServiceSelection,
  readSpotDefault,
  resolveInitialSelection,
} from '../../../domain/serviceDefaults.js';

// Matches the old Mantine useHotkeys default: ignore key events from form fields.
const TAGS_TO_IGNORE = ['INPUT', 'TEXTAREA', 'SELECT'];

const SERVICE_KEY = 'plaid_igt_transcribe_service';
const PARAMS_PREFIX = 'plaid_igt_transcribe_params_';

// Per-user listening preferences. They shape how the recording is heard, not
// what is stored, so they live in the browser like the copy-as-IGT favorite.
const RATE_KEY = 'plaid_igt_playback_rate';
const LOOP_KEY = 'plaid_igt_loop_segment';
const AUTOPLAY_KEY = 'plaid_igt_play_on_focus';
export const PLAYBACK_RATE_MIN = 0.2;
export const PLAYBACK_RATE_MAX = 5;
export const PLAYBACK_RATE_STEP = 0.05;
// Snap a rate onto the slider's grid and into its range.
export const clampRate = (rate) => {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 1;
  const snapped = Math.round(n / PLAYBACK_RATE_STEP) * PLAYBACK_RATE_STEP;
  return Number(Math.min(PLAYBACK_RATE_MAX, Math.max(PLAYBACK_RATE_MIN, snapped)).toFixed(2));
};

const readStored = (key, fallback, parse) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = parse(raw);
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
};
const writeStored = (key, value) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // A full or blocked store only loses the preference for next time.
  }
};
const parseRate = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) ? clampRate(n) : undefined;
};
const parseBool = (raw) => (raw === 'true' ? true : raw === 'false' ? false : undefined);

// Media tab operations, backed by the shared IgtDocument. This hook OWNS all
// transient media UI state (playback position, selection, popover, ASR options)
// as local React state, and delegates every mutation to the domain model
// (doc.uploadMedia/deleteMedia/clearAlignments/etc., all _withSaving-wrapped so
// they single-flight + toast + reload-on-error). The returned object is the
// single source the timeline + player read from.
export const useMediaOperations = () => {
  const { doc } = useDocumentCtx();
  useIgtDocument(doc);
  const confirm = useConfirm();

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

  // Listening preferences (see the *_KEY constants). `playbackRateRef` mirrors
  // the state for the deps-`[]` element registration, like `volumeRef`.
  const [playbackRate, setPlaybackRate] = useState(() => readStored(RATE_KEY, 1, parseRate));
  const playbackRateRef = useRef(playbackRate);
  const [loopSegment, setLoopSegmentState] = useState(() => readStored(LOOP_KEY, false, parseBool));
  const [autoPlayOnFocus, setAutoPlayOnFocusState] = useState(() =>
    readStored(AUTOPLAY_KEY, true, parseBool),
  );

  // ASR service hook
  const {
    availableServices,
    isDiscovering,
    discoverServices,
    isProcessing,
    requestService,
    hasServices,
    progressPercent,
    progressMessage,
  } = useServiceRequest();

  // The selected ASR service (null for none) and its user-controllable
  // arguments. Defined before handleTranscribe so it can merge the args.
  const selectedServiceId = asrAlgorithm.startsWith('service:') ? asrAlgorithm.slice(8) : null;
  const selectedService = selectedServiceId
    ? availableServices.find((s) => s.serviceId === selectedServiceId) || null
    : null;
  const transcribeDefault = readSpotDefault(project, TASKS.TRANSCRIBE);
  const {
    schema: paramSchema,
    values: paramValues,
    setParam: setParamValue,
    coerced: coerceParams,
    errors: paramErrors,
  } = useServiceParams(
    selectedService,
    PARAMS_PREFIX,
    transcribeDefault?.service?.serviceId === selectedServiceId ? transcribeDefault?.params : null,
  );

  // The media endpoint needs auth, and a <video src> can't carry an
  // Authorization header. We used to work around that with `?token=<jwt>` on
  // the URL, which put a 30-day login token everywhere a URL travels: proxy
  // access logs, and whatever the user gets from "Copy video address". Instead
  // fetch the bytes once with a real header and hand the element a blob: URL,
  // which is meaningless outside this page and dies with the tab. The blob is
  // also what the timeline decodes for its waveform, so this is one download
  // where it used to be two.
  const mediaSrcUrl = doc.document.mediaUrl;
  const [media, setMedia] = useState({ url: null, blob: null });
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [mediaLoadError, setMediaLoadError] = useState(null);

  useEffect(() => {
    // Clear eagerly so a stale blob never shows under a new (or deleted)
    // media file while the fetch below is still in flight.
    setMedia({ url: null, blob: null });
    setMediaLoadError(null);
    if (!mediaSrcUrl) {
      setIsLoadingMedia(false);
      return;
    }

    let cancelled = false;
    let objectUrl = null;
    setIsLoadingMedia(true);

    (async () => {
      try {
        const response = await fetch(mediaSrcUrl, {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        });
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setMedia({ url: objectUrl, blob });
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load media:', error);
        setMediaLoadError(error?.message ?? String(error));
      } finally {
        if (!cancelled) setIsLoadingMedia(false);
      }
    })();

    return () => {
      cancelled = true;
      // Without this the downloaded file stays pinned for the life of the tab.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mediaSrcUrl]);

  const authenticatedMediaUrl = media.url;
  const mediaBlob = media.blob;

  // Get alignment token layer and tokens
  const alignmentTokenLayer = doc.layerInfo.alignmentTokenLayer;
  const alignmentTokens = doc.alignmentTokens || [];

  // Media playback operations
  const setMediaElement = useCallback((element) => {
    mediaElementRef.current = element;
    // Apply the current volume to a freshly-registered element. This covers the
    // element mounting after the initial 0.8 (or a later value) was set, since
    // the `[volume]` effect below won't re-run just because the ref changed.
    if (element) {
      element.volume = volumeRef.current;
      element.playbackRate = playbackRateRef.current;
    }
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

  // Play one stretch of the recording and stop (or loop) at its end. Setting
  // currentTime moves the official playback position at once, so play() picks
  // up from the new position without waiting for `seeked`. The returned
  // promise is ignored: a rejection here is the browser's autoplay policy, and
  // every caller runs from a user gesture.
  const playRange = useCallback((range) => {
    const el = mediaElementRef.current;
    if (!range || !el) return;
    el.currentTime = range.start;
    setCurrentTime(range.start);
    setPlayingSelection({ start: range.start, end: range.end });
    el.play().catch(() => {});
  }, []);

  const handlePlaySelection = useCallback(() => {
    if (selection) playRange(selection);
  }, [selection, playRange]);

  const pausePlayback = useCallback(() => {
    mediaElementRef.current?.pause();
  }, []);

  // Play from the playhead, or pause. Free playback (no range) never auto-stops.
  const togglePlayback = useCallback(() => {
    const el = mediaElementRef.current;
    if (!el) return;
    if (isPlaying) {
      el.pause();
    } else {
      setPlayingSelection(null);
      el.play().catch(() => {});
    }
  }, [isPlaying]);

  // Move playback by `delta` seconds, keeping it in the recording. Any range
  // being played is dropped: after a seek the user is listening freely.
  const seekBy = useCallback(
    (delta) => {
      const el = mediaElementRef.current;
      if (!el) return;
      const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
      const t = Math.max(0, Math.min(max || 0, el.currentTime + delta));
      el.currentTime = t;
      setCurrentTime(t);
      setPlayingSelection(null);
      if (autoScrollToTimeRef.current) autoScrollToTimeRef.current(t);
    },
    [duration],
  );

  const handlePlaybackRateChange = useCallback((rate) => {
    const value = clampRate(rate);
    playbackRateRef.current = value;
    setPlaybackRate(value);
    if (mediaElementRef.current) mediaElementRef.current.playbackRate = value;
    writeStored(RATE_KEY, value);
  }, []);

  const setLoopSegment = useCallback((on) => {
    setLoopSegmentState(!!on);
    writeStored(LOOP_KEY, !!on);
  }, []);

  const setAutoPlayOnFocus = useCallback((on) => {
    setAutoPlayOnFocusState(!!on);
    writeStored(AUTOPLAY_KEY, !!on);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelection(null);
    setPopoverOpened(false);
  }, []);

  // Media upload operations
  const handleMediaUpload = useCallback(
    async (file) => {
      if (!file) return;

      setIsUploading(true);
      const ok = await doc.uploadMedia(file);
      setIsUploading(false);
      if (ok) {
        notifySuccess('Media file uploaded successfully', 'Success');
      }
    },
    [doc],
  );

  const handleDeleteMedia = useCallback(async () => {
    if (!doc.document.id) return;

    if (
      !(await confirm({
        title: 'Delete media file?',
        description:
          'This will permanently remove the audio/video from this document. ' +
          'This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      }))
    ) {
      return;
    }

    const ok = await doc.deleteMedia();
    if (ok) {
      notifySuccess('Media file has been deleted successfully', 'Media Deleted');
    }
  }, [doc, confirm]);

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

    // Re-transcribe is destructive: the ASR workflow APPENDS to existing text
    // rather than replacing it, and interleaved ASR is not supported — so a
    // re-run must start from a clean slate. If the document already has a
    // transcript, confirm, then wipe the baseline before transcribing fresh.
    const hasExistingTranscript = !!(doc.body && doc.body.trim());
    if (
      hasExistingTranscript &&
      !(await confirm({
        title: 'Replace existing transcript?',
        description:
          'This document already has a transcript. Transcribing again will REPLACE it, ' +
          'discarding the existing text, tokens, segments, and any annotations on them. ' +
          'This cannot be undone.',
        confirmLabel: 'Replace',
        destructive: true,
      }))
    ) {
      return;
    }

    // Find text, alignment token, and sentence token layers
    const primaryTextLayer = doc.layerInfo.primaryTextLayer;
    const alignmentTokenLayer = doc.layerInfo.alignmentTokenLayer;
    const sentenceTokenLayer = doc.layerInfo.sentenceTokenLayer;

    try {
      // The whole re-transcribe (our wipe of the previous transcript + every
      // write the ASR service makes) is ONE logical operation in the audit
      // log: the open operation propagates to the service via the request.
      const label = `Transcribe audio (${selectedService?.serviceName || serviceId})`;
      await doc.client.withOperation(label, async () => {
        // Start from a clean slate: setting the body to '' cascade-deletes its
        // tokens, sentences, alignments, and every annotation on them, so ASR
        // builds a fresh document instead of appending a second transcript.
        if (hasExistingTranscript) {
          updateProgress(5, 'Clearing the previous transcript...');
          await doc.saveBaselineText('');
        }
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
            errorMessage: 'An error occurred during transcription',
          },
        );
      });

      updateProgress(100, 'Transcription complete!');

      // Note: For ASR transcription, we reload since it creates many alignment
      // tokens and the service response doesn't include the created token data.
      await doc._reload();
    } catch (error) {
      console.error('Transcription failed:', error);
      updateProgress(0, '');
    }
  }, [
    asrAlgorithm,
    doc,
    project,
    requestService,
    selectedService,
    updateProgress,
    coerceParams,
    paramErrors,
    confirm,
  ]);

  const handleClearAlignments = useCallback(async () => {
    if (!alignmentTokens.length) return;

    if (
      !(await confirm({
        title: 'Clear all segments?',
        description:
          'This removes every segment from this document. The text stays in the baseline. ' +
          'This cannot be undone.',
        confirmLabel: 'Clear segments',
        destructive: true,
      }))
    ) {
      return;
    }

    updateProgress(25, 'Clearing segments…');
    const count = alignmentTokens.length;
    const ok = await doc.clearAlignments();
    updateProgress(100, 'Segments cleared');
    if (ok) {
      notifySuccess(`Cleared ${count} segments`, 'Success');
    }
    setTranscriptionProgress(0);
    setCurrentOperation('');
  }, [alignmentTokens, doc, updateProgress, confirm]);

  // Deleting a segment deletes its text from the baseline (the cascade then
  // removes the token), so it is confirmed with what actually goes.
  const handleDeleteAlignment = useCallback(
    async (alignmentId) => {
      if (
        !(await confirm({
          title: 'Delete segment?',
          description:
            "This removes the segment's text from the baseline, including any words, glosses, " +
            'and annotations on it. This cannot be undone.',
          confirmLabel: 'Delete segment',
          destructive: true,
        }))
      ) {
        return false;
      }
      return doc.deleteAlignment(alignmentId);
    },
    [doc, confirm],
  );

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

  useEffect(() => {
    playbackRateRef.current = playbackRate;
    if (mediaElementRef.current) mediaElementRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // Setup hotkeys (replaces Mantine useHotkeys; ignores events from form fields).
  useEffect(() => {
    const onKeyDown = (e) => {
      // Ctrl/Cmd+Left / Ctrl/Cmd+Right seek one second, in a text box or out of
      // one, so a transcriber can re-hear a stretch without leaving the row.
      // Inside the transcript's text boxes this takes the place of word-jump
      // (Ctrl) and line start/end (Cmd); on a Mac, Ctrl+Arrow belongs to the
      // system, so Cmd is the only key that can carry the gesture there.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        seekBy(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (TAGS_TO_IGNORE.includes(e.target?.tagName)) return;
      // ESC key to clear selection
      if (e.key === 'Escape') {
        if (selection) {
          setSelection(null);
          setPopoverOpened(false);
        }
      } else if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+Space to play selection
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
  }, [selection, isPlaying, handlePlaySelection, seekBy]);

  // Monitor range playback: at the end of the range, loop back to its start
  // when looping is on, otherwise snap to the end and pause.
  useEffect(() => {
    const monitorSelection = () => {
      if (playingSelection && mediaElementRef.current && isPlaying) {
        const t = mediaElementRef.current.currentTime;
        if (t >= playingSelection.end) {
          if (loopSegment) {
            mediaElementRef.current.currentTime = playingSelection.start;
          } else {
            mediaElementRef.current.currentTime = playingSelection.end;
            mediaElementRef.current.pause();
            setPlayingSelection(null);
            return; // Stop monitoring
          }
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
  }, [playingSelection, isPlaying, loopSegment]);

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
      .map((service) => ({
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
    const onlineServices = filterServicesByTask(availableServices, TASKS.TRANSCRIBE).filter(
      (s) => s.online !== false,
    );
    setAsrAlgorithm((cur) => {
      if (cur && asrAlgorithmOptions.some((opt) => opt.value === cur)) return cur;
      return (
        resolveInitialSelection({
          services: onlineServices,
          cached: localStorage.getItem(SERVICE_KEY),
          projectDefault: readSpotDefault(project, TASKS.TRANSCRIBE),
        }) || ''
      );
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
    mediaBlob,
    isLoadingMedia,
    mediaLoadError,
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
    playRange,
    pausePlayback,
    togglePlayback,
    seekBy,

    // Listening preferences
    playbackRate,
    handlePlaybackRateChange,
    loopSegment,
    setLoopSegment,
    autoPlayOnFocus,
    setAutoPlayOnFocus,

    // Media file operations
    handleMediaUpload,
    handleDeleteMedia,

    // Segment operations
    handleDeleteAlignment,

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
    mediaElementRef,
  };
};
