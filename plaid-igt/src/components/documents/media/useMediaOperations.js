import { useEffect, useCallback, useRef, useState } from 'react';
import { TASKS } from '@larc-iu/plaid-client';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useServiceRequest } from '../../documents/hooks/useServiceRequest.js';
import { useServiceSpot } from '../../documents/hooks/useServiceSpot.js';
import { useRunProgress, useMirroredProgress } from '../../documents/hooks/useRunProgress.js';
import { whenIdle } from '../../../domain/whenIdle.js';
import { transcodeToMp3 } from '../../../domain/media/transcodeToMp3.js';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import { useVadProposals } from './useVadProposals.js';
import { DETECT_SPEECH_BUILTIN } from './detectSpeechBuiltin.js';

// Matches the old Mantine useHotkeys default: ignore key events from form fields.
const TAGS_TO_IGNORE = ['INPUT', 'TEXTAREA', 'SELECT'];

const DETECT_BUILTINS = [DETECT_SPEECH_BUILTIN];

// Per-user listening preferences. They shape how the recording is heard, not
// what is stored, so they live in the browser like the copy-as-IGT favorite.
const RATE_KEY = 'plaid_igt_playback_rate';
const LOOP_KEY = 'plaid_igt_loop_segment';
const AUTOPLAY_KEY = 'plaid_igt_play_on_focus';
// 0.25 is the slowest Firefox will still play audibly (it mutes below), and
// Chrome plays it too.
export const PLAYBACK_RATE_MIN = 0.25;
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
  // A click on a timeline segment asks the transcript to focus that row. A
  // fresh object per request, so the same segment can be asked for twice.
  const [segmentFocusRequest, setSegmentFocusRequest] = useState(null);
  const requestSegmentFocus = useCallback(
    (id) => setSegmentFocusRequest({ id, at: Date.now() }),
    [],
  );
  const [pixelsPerSecond, setPixelsPerSecond] = useState(25);
  const [isUploading, setIsUploading] = useState(false);
  // `{ name, loaded, total }` while a file is going up, else null. `total`
  // is the request body (the file plus a few bytes of multipart framing).
  const [uploadProgress, setUploadProgress] = useState(null);
  // {name, fraction} while a recording is being converted, else null.
  const [convertProgress, setConvertProgress] = useState(null);

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

  // The two integration spots on this tab. Both offer whatever services are
  // online for their task; speech detection also offers the in-browser model.
  const transcribeSpot = useServiceSpot({
    task: TASKS.TRANSCRIBE,
    project,
    services: availableServices,
    storageId: 'transcribe',
  });
  const detectSpot = useServiceSpot({
    task: TASKS.DETECT_SPEECH,
    project,
    services: availableServices,
    builtins: DETECT_BUILTINS,
    storageId: 'detect_speech',
  });

  // One run clock per spot, so a closed dialog's button can still show it.
  const transcribeRun = useRunProgress();
  const detectRun = useRunProgress();
  useMirroredProgress(transcribeRun, {
    percent: progressPercent,
    message: progressMessage,
    active: transcribeRun.running,
  });
  // A detect-speech SERVICE reports over the same channel; the built-in model
  // reports its own fraction, mirrored just below where `vad` is built.
  useMirroredProgress(detectRun, {
    percent: progressPercent,
    message: progressMessage,
    active: detectRun.running && !!detectSpot.service,
  });

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

  // Speech detection. Proposals live in the tab, never on the server, until
  // someone types into one. See useVadProposals.js for why.
  const vad = useVadProposals({
    mediaBlob,
    mediaKey: mediaSrcUrl,
    alignmentTokens,
    params: detectSpot.params.coercedValues,
    methodKey: detectSpot.selection,
  });
  useMirroredProgress(detectRun, {
    percent: vad.progress > 0 ? vad.progress * 100 : null,
    message: 'Detecting speech…',
    active: detectRun.running && !detectSpot.service,
  });

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

  // The recording's own clock, for a write that must not use a displayed
  // (throttled) time: the element is the truth, the state is a picture of it.
  const getCurrentTime = useCallback(() => {
    const el = mediaElementRef.current;
    return el && Number.isFinite(el.currentTime) ? el.currentTime : null;
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

  // Play a stretch the way a transcriber expects of a segment they paused in:
  // on from where playback stopped when that is inside the stretch (pausing
  // to type must not throw the listener back to the start), from the start
  // when playback is elsewhere or already at the end. Stops at the end
  // either way.
  const playRangeFromHere = useCallback((range) => {
    const el = mediaElementRef.current;
    if (!range || !el) return;
    const at = el.currentTime;
    const inside = Number.isFinite(at) && at >= range.start && at < range.end - 0.05;
    if (!inside) {
      el.currentTime = range.start;
      setCurrentTime(range.start);
    }
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
  // `convert` sends the recording as mono 16 kHz MP3 instead of itself: a
  // recording too large for the server becomes one that fits, and its timeline
  // is unchanged, so segments made against either line up with the other.
  const handleMediaUpload = useCallback(
    async (file, { convert = false } = {}) => {
      if (!file) return;

      let sending = file;
      if (convert) {
        setConvertProgress({ name: file.name, fraction: 0 });
        try {
          sending = await transcodeToMp3(file, {
            onProgress: (fraction) => setConvertProgress((p) => (p ? { ...p, fraction } : p)),
          });
        } catch (error) {
          console.error('Converting the recording failed:', error);
          notifyError(
            error?.message || 'This file could not be converted. Upload it as it is.',
            'Conversion failed',
          );
          return;
        } finally {
          setConvertProgress(null);
        }
        if (!sending) return;
      }

      setIsUploading(true);
      setUploadProgress({ name: sending.name, loaded: 0, total: sending.size });
      try {
        const ok = await doc.uploadMedia(sending, {
          onProgress: ({ loaded, total }) =>
            setUploadProgress((p) => (p ? { ...p, loaded, total: total ?? p.total } : p)),
        });
        if (ok) {
          notifySuccess('Media file uploaded successfully', 'Success');
        }
      } finally {
        setIsUploading(false);
        setUploadProgress(null);
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
  const handleTranscribe = useCallback(async () => {
    const service = transcribeSpot.service;
    if (!service) return;

    const serviceId = service.serviceId;
    const documentId = doc.document.id;

    if (!documentId) {
      notifyError('Document ID not found', 'Error');
      return;
    }

    // Block on unmet required service arguments before doing any work.
    const missing = Object.values(transcribeSpot.params.errors);
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
      const label = `Transcribe audio (${service.serviceName || serviceId})`;
      transcribeRun.start(['Transcribe']);
      await doc.client.withOperation(label, async () => {
        // Start from a clean slate: setting the body to '' cascade-deletes its
        // tokens, sentences, alignments, and every annotation on them, so ASR
        // builds a fresh document instead of appending a second transcript.
        if (hasExistingTranscript) {
          transcribeRun.report({ message: 'Clearing the previous transcript…' });
          await doc.saveBaselineText('');
        }
        transcribeRun.report({ message: 'Starting the service…' });

        await requestService(
          project.id,
          documentId,
          serviceId,
          {
            // User-controlled arguments declared by the service, spread FIRST so
            // the fixed layer/doc params below always win over any same-named arg.
            ...transcribeSpot.params.coerced(),
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

      // A full reload of a freshly transcribed document is seconds of work
      // with nothing else on screen to show for it, so it is named like any
      // other step rather than left as dead air.
      transcribeRun.report({ percent: null, message: 'Loading the transcript…' });
      await doc._reload();
    } catch (error) {
      console.error('Transcription failed:', error);
    } finally {
      transcribeRun.finish();
    }
  }, [doc, project, requestService, transcribeSpot, transcribeRun, confirm]);

  // Speech detection: the built-in runs in this tab, a service returns regions
  // that land in the same proposal list. Either way nothing is written until
  // somebody types into a proposal.
  const handleDetectSpeech = useCallback(async () => {
    const service = detectSpot.service;
    if (!service) {
      detectRun.start(['Detect speech']);
      try {
        await vad.detect();
      } finally {
        detectRun.finish();
      }
      return;
    }
    const missing = Object.values(detectSpot.params.errors);
    if (missing.length) {
      notifyError(missing[0], 'Missing required option');
      return;
    }
    detectRun.start(['Detect speech']);
    vad.beginServiceRun();
    try {
      const result = await requestService(
        project.id,
        doc.document.id,
        service.serviceId,
        {
          ...detectSpot.params.coerced(),
          documentId: doc.document.id,
          projectId: project.id,
        },
        {
          successTitle: 'Speech detection complete',
          successMessage: `${service.serviceName} finished.`,
          errorTitle: 'Speech detection failed',
          errorMessage: `${service.serviceName} reported an error.`,
        },
      );
      // A detect-speech service RETURNS its regions and writes nothing: a
      // segment is a stretch of the baseline and cannot exist without text.
      vad.acceptServiceRegions(result?.segments ?? result?.proposals ?? []);
    } catch (error) {
      vad.failRun(error?.message ?? String(error));
    } finally {
      detectRun.finish();
    }
  }, [detectSpot, detectRun, vad, requestService, project, doc]);

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

    const count = alignmentTokens.length;
    const ok = await doc.clearAlignments();
    if (ok) {
      notifySuccess(`Cleared ${count} segments`, 'Success');
    }
  }, [alignmentTokens, doc, confirm]);

  // Deleting a segment takes its times and speaker; its text stays in the
  // baseline unless the dialog's box is ticked, which deletes the text and
  // everything annotated on it as well.
  const handleDeleteAlignment = useCallback(
    async (alignmentId) => {
      const answer = await confirm({
        title: 'Delete segment?',
        description: 'The segment is removed. Its text stays in the baseline.',
        checkbox: {
          label: 'Also delete its text from the baseline',
          description:
            'The words, glosses, and annotations on that text go with it. This cannot be undone.',
          confirmLabel: 'Delete segment and text',
        },
        confirmLabel: 'Delete segment',
        destructive: true,
      });
      if (!answer) return false;
      await whenIdle(doc);
      return doc.deleteAlignment(alignmentId, { deleteText: answer.checked });
    },
    [doc, confirm],
  );

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
      // Shift+Left / Shift+Right seek one second, in a text box or out of one,
      // so a transcriber can re-hear a stretch without leaving the row. Shift
      // for the same reason as Shift+Space: Ctrl+Arrow is Mission Control on a
      // Mac and Cmd+Arrow is line start/end in every text box, while Shift is
      // the one modifier every platform leaves alone. Inside a row this costs
      // extending a selection by one character, and nothing else. A box that
      // exists to be selected in (the popover's existing-text box, marked
      // aria-readonly) is the exception: the keys keep their meaning there.
      if (
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        e.target?.getAttribute?.('aria-readonly') !== 'true'
      ) {
        e.preventDefault();
        seekBy(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      // Shift+Space pauses, or plays the selected stretch on from where it
      // stopped, outside a text box.
      // (Inside one, the row handles it for its own segment.) Shift because
      // it is the one modifier every platform leaves alone: Ctrl+Space and
      // Cmd+Space belong to macOS, Alt+Space to Windows and GNOME.
      if (
        e.code === 'Space' &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !TAGS_TO_IGNORE.includes(e.target?.tagName)
      ) {
        e.preventDefault();
        const el = mediaElementRef.current;
        if (!el) return;
        if (isPlaying) el.pause();
        else if (selection) playRangeFromHere(selection);
        else el.play().catch(() => {});
        return;
      }
      if (TAGS_TO_IGNORE.includes(e.target?.tagName)) return;
      // ESC key to clear selection
      if (e.key === 'Escape') {
        if (selection) {
          setSelection(null);
          setPopoverOpened(false);
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
  }, [selection, isPlaying, playRangeFromHere, seekBy]);

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
    segmentFocusRequest,
    requestSegmentFocus,
    pixelsPerSecond,
    setPixelsPerSecond,

    // Service spots (method + options) and their run clocks
    transcribeSpot,
    transcribeRun,
    detectSpot,
    detectRun,
    isProcessing,

    // Upload state
    isUploading,
    uploadProgress,

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
    getCurrentTime,
    playRange,
    playRangeFromHere,
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
    convertProgress,
    handleDeleteMedia,

    // Segment operations
    handleDeleteAlignment,

    // Speech detection (proposals, not data)
    vad,

    // ASR + speech detection
    handleTranscribe,
    handleDetectSpeech,
    handleClearAlignments,

    // Service discovery
    discoverServices,
    isDiscovering,
    availableServices,
    hasServices,

    // Refs
    mediaElementRef,
  };
};
