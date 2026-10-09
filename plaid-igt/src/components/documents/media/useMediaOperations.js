import { useEffect, useCallback, useRef, useState } from 'react';
import { TASKS, serviceSource } from '@larc-iu/plaid-client';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { transcribeNotice } from './transcribeNotice.js';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import {
  notifySuccess,
  notifyError,
  notifyInfo,
  notifyWarning,
  humanizeError,
} from '@/utils/feedback';
import { recordingChangeNotice } from './recordingChange.js';
import { useServiceRequest } from '@ui/hooks/useServiceRequest.js';
import { useServiceSpot } from '@ui/hooks/useServiceSpot.js';
import { useRunProgress, useMirroredProgress } from '@ui/hooks/useRunProgress.js';
import { transcodeToMp3 } from '../../../domain/media/transcodeToMp3.js';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { useVadProposals, VAD_METADATA_KEY } from './useVadProposals.js';
import { DETECT_SPEECH_BUILTIN } from './detectSpeechBuiltin.js';
import { writeRunRecord, clearRunRecord } from '@ui/domain/runRecord.js';
import { reloadAfterRun } from '@ui/lib/runReload.js';
import { keys } from '@/lib/keymap.js';
import { createPlaybackClock } from './playbackClock.js';
import { RUNNING_TIME_MS } from './useThrottledValue.js';

// Hotkeys ignore key events from form fields, with one exception: the tab's
// own boxes (transcript rows, time boxes, the alignment popover) sit under a
// `data-media-keys` root and take the seek chords, so a transcriber can re-hear
// a stretch without leaving the row. A dialog, and the assistant composer
// (always mounted, on every tab), are text boxes like any other. A box that
// exists to be selected in (aria-readonly) keeps its keys even under the root.
const TAGS_TO_IGNORE = ['INPUT', 'TEXTAREA', 'SELECT'];
const isTextTarget = (t) => TAGS_TO_IGNORE.includes(t?.tagName) || !!t?.isContentEditable;
const takesMediaKeys = (t) =>
  !!t?.closest?.('[data-media-keys]') && t.getAttribute('aria-readonly') !== 'true';
// Space on a focused button, link or toggle is that control's own activation.
const isActivatable = (t) =>
  !!t?.closest?.(
    'button, a, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]',
  );

const DETECT_BUILTINS = [DETECT_SPEECH_BUILTIN];

// MediaError.MEDIA_ERR_DECODE, named here since jsdom has no MediaError.
const MEDIA_ERR_DECODE = 3;
// A link is renewed by itself at most this often. A link lasts hours, so one
// that stops working is renewed at once, while a recording that fails for
// another reason is not asked for again and again. Measured on the page's own
// clock, which a wrong system clock cannot move.
const RELINK_INTERVAL_MS = 5 * 60 * 1000;

// How long an ASR service may say NOTHING before the page gives up waiting.
// Not a cap on the run: the client's clock restarts on every progress event.
// It needs to be this long because a transcriber's model pass is one blocking
// call. Whisper reports "Transcribing audio…" and then says nothing until it
// has the whole transcript, which on a long recording is tens of minutes. The
// five-minute default was shorter than the work, so a working transcription
// was reported as failed and its writes landed on a document the page had
// already handed back as editable, with its baseline wiped ready for them.
const TRANSCRIBE_TIMEOUT_MS = 60 * 60 * 1000;

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
const clampRate = (rate) => {
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
// (doc.uploadMedia/deleteMedia/clearAlignments/etc., each queued behind the
// write in flight, with a toast and a reload on error). The returned object is the
// single source the timeline + player read from.
export const useMediaOperations = () => {
  const { doc, client, acquireWriteLock, canWrite } = useDocumentCtx();
  useDocumentModel(doc);
  const confirm = useConfirm();

  const project = doc.project;

  const mediaElementRef = useRef(null);
  const autoScrollToTimeRef = useRef(null);

  // The player's element, in state as well as in the ref. The ref is for the
  // imperative work here (seek, play, pause), which always runs after the
  // element has registered. The state is for everything downstream: the
  // timeline derives its needle and its click target from the element, and a
  // ref re-renders nothing, so the timeline was blind to the element until
  // some unrelated change happened to re-render it.
  const [mediaElement, setMediaElementState] = useState(null);

  // Local media UI state. The position is two things: `clock`, exact and
  // updated every frame while playing, for the needle and the seek bar, and
  // `currentTime`, React state that follows it a few times a second while
  // playing and exactly otherwise, for everything else (playbackClock.js).
  const [clock] = useState(createPlaybackClock);
  const [currentTime, setCurrentTimeState] = useState(0);
  const setCurrentTime = useCallback(
    (time) => {
      clock.set(time);
      setCurrentTimeState(time);
    },
    [clock],
  );
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
    cancelRequest,
    hasServices,
    progressPercent,
    progressMessage,
  } = useServiceRequest(client);

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
  // The banner is the only surface once the user leaves this tab.
  const lockRef = useRef(null);
  useEffect(() => {
    if (progressMessage) lockRef.current?.setStatus(progressMessage);
  }, [progressMessage]);
  // A detect-speech SERVICE reports over the same channel; the built-in model
  // reports its own fraction, mirrored just below where `vad` is built.
  useMirroredProgress(detectRun, {
    percent: progressPercent,
    message: progressMessage,
    active: detectRun.running && !!detectSpot.service,
  });

  // The media endpoint needs auth, and a <video src> can't carry an
  // Authorization header. A login token in the URL (`?token=`) put a 30-day
  // credential in proxy logs and in "Copy video address", and handing the
  // element a blob: URL of the whole file instead meant nothing played until
  // every byte had arrived. So the element gets a media LINK
  // (`documents.mediaLink`): the recording's URL with a token that opens that
  // one recording, for a few hours, and nothing else. The element streams it
  // and seeks by range at once.
  //
  // The waveform and speech detection still read the whole file, so it is
  // fetched as well, through the same link (this page's own session, never
  // whichever login another tab left in storage), behind the player and never
  // holding it up.
  const mediaSrcUrl = doc.document.mediaUrl;
  const documentId = doc.document.id;
  // `url` is the link the element plays. `key` is the versioned media URL,
  // which names the recording for anything cached per recording (the
  // waveform). `blob` is the whole file, once it has arrived.
  const [media, setMedia] = useState({ url: null, blob: null, key: null });
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  const [mediaLoadError, setMediaLoadError] = useState(null);
  // A link that stopped working is asked for again (see relinkMedia).
  // `renewedAt` is when that last happened by itself, so it cannot become a
  // loop over a file that fails for some other reason.
  const relinkRef = useRef({ key: null, renewedAt: null, resume: null });
  // The whole-file read of the recording on screen, for a renewal to start
  // when the first link never arrived and so never started it.
  const readWholeRef = useRef(null);
  const mediaBlobRef = useRef(null);
  mediaBlobRef.current = media.blob;

  useEffect(() => {
    // Clear eagerly so a stale recording never shows under a new (or deleted)
    // media file while the requests below are still in flight.
    setMedia({ url: null, blob: null, key: null });
    setMediaLoadError(null);
    relinkRef.current = { key: mediaSrcUrl, renewedAt: null, resume: null };
    readWholeRef.current = null;
    // The element may still be reading the old link, and an error from it is
    // not this recording's. Another recording starts at its start, and so does
    // the needle.
    mediaElementRef.current?.pause();
    setCurrentTime(0);
    if (!mediaSrcUrl) {
      setIsLoadingMedia(false);
      return undefined;
    }

    let cancelled = false;
    const reading = new AbortController();
    setIsLoadingMedia(true);

    const readWhole = async (url) => {
      readWholeRef.current = null;
      try {
        const response = await fetch(url, { signal: reading.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!cancelled) setMedia((m) => ({ ...m, blob }));
      } catch (error) {
        // The player does not need it. The waveform draws a flat line and
        // detection stays off, which say enough, until a renewed link reads
        // it again.
        if (cancelled) return;
        readWholeRef.current = readWhole;
        console.error('Failed to read the whole recording:', error);
      }
    };

    (async () => {
      try {
        const link = await client.documents.mediaLink(documentId);
        if (cancelled) return;
        setMedia((m) => ({ ...m, url: link.url, key: mediaSrcUrl }));
        readWhole(link.url);
      } catch (error) {
        if (cancelled) return;
        readWholeRef.current = readWhole;
        console.error('Failed to load media:', error);
        setMediaLoadError(humanizeError(error, 'The media could not be loaded.'));
      } finally {
        if (!cancelled) setIsLoadingMedia(false);
      }
    })();

    return () => {
      cancelled = true;
      reading.abort();
    };
  }, [client, documentId, mediaSrcUrl, setCurrentTime]);

  // Ask for a new link and carry on from where playback was. `force` is the
  // person asking (Try again), which is always honoured.
  const renewLink = useCallback(
    ({ force = false } = {}) => {
      const relink = relinkRef.current;
      if (!relink.key) return false;
      const now = performance.now();
      if (!force && relink.renewedAt !== null && now - relink.renewedAt < RELINK_INTERVAL_MS) {
        return false;
      }
      if (!force) relink.renewedAt = now;
      const el = mediaElementRef.current;
      relink.resume =
        el && mediaUrlRef.current ? { time: el.currentTime, playing: !el.paused } : null;
      const key = relink.key;
      setMediaLoadError(null);
      client.documents
        .mediaLink(documentId)
        .then((link) => {
          if (relinkRef.current.key !== key) return;
          // The same link again (it cannot be, as core mints them, but a
          // player handed the src it has does nothing at all) is reloaded.
          if (link.url === mediaUrlRef.current) mediaElementRef.current?.load();
          setMedia((m) => ({ ...m, url: link.url, key }));
          if (!mediaBlobRef.current) readWholeRef.current?.(link.url);
        })
        .catch((error) => {
          if (relinkRef.current.key !== key) return;
          console.error('Failed to load media:', error);
          setMediaLoadError(humanizeError(error, 'The media could not be loaded.'));
        });
      return true;
    },
    [client, documentId],
  );

  // The element could not read its link. A link stops working when it
  // expires or the session ends, and the element says only that it failed,
  // with a code: a file that does not decode is the file's fault, and a new
  // link would fail the same way. Returns whether a new link is on its way,
  // so the player says nothing until it is not.
  const relinkMedia = useCallback(
    (code) => {
      if (code === MEDIA_ERR_DECODE) return false;
      // No link for this recording has been handed over yet: the error is
      // the old recording's.
      if (!mediaUrlRef.current) return false;
      return renewLink();
    },
    [renewLink],
  );
  const retryMedia = useCallback(() => renewLink({ force: true }), [renewLink]);

  // A recording deleted or replaced by someone else is said so once the
  // document is read again (recordingChange.js), with what a write refused
  // for it left unsaved. This page's own delete is not: it shows at once,
  // and the flag is up while it does.
  const ownDeleteRef = useRef(false);
  // While this tab is shown, a write refused for a change to the recording
  // is this notice's to say (mutations/alignment.js).
  useEffect(() => doc.watchRecording?.(), [doc]);
  const seenMediaRef = useRef({ id: doc.document.id, url: mediaSrcUrl });
  useEffect(() => {
    const seen = seenMediaRef.current;
    seenMediaRef.current = { id: doc.document.id, url: mediaSrcUrl };
    if (seen.id !== doc.document.id) return;
    const notice = recordingChangeNotice(seen.url, mediaSrcUrl, {
      ownDelete: ownDeleteRef.current,
      notSaved: seen.url !== mediaSrcUrl ? doc.takeRecordingRefusal?.(mediaSrcUrl) : null,
    });
    if (notice) notifyWarning(notice.message, notice.title);
  }, [doc, doc.document.id, mediaSrcUrl]);

  const authenticatedMediaUrl = media.url;
  const mediaBlob = media.blob;
  const mediaBlobKey = media.key;

  // Whether the element has read the file it was handed. The file arrives
  // whole after the tab opens, and the transcript rows and the keys are live
  // before it does. A seek or a play made on an element with no file yet is
  // lost: the load puts the playhead back to 0 and aborts the play. So every
  // path that moves or plays the element waits for this, keyed to the URL so
  // that a new file loading in place of the old one waits again. The player
  // reports it from `loadedmetadata`. The ref is for the callbacks below, which
  // keep their identity across renders.
  const [loadedUrl, setLoadedUrl] = useState(null);
  const mediaReady = !!media.url && loadedUrl === media.url;
  const mediaUrlRef = useRef(media.url);
  mediaUrlRef.current = media.url;
  const loadedUrlRef = useRef(null);
  const handleMediaLoaded = useCallback((url) => {
    loadedUrlRef.current = url;
    setLoadedUrl(url);
    setMediaLoadError(null);
    // A new link for the same recording goes on from where the old one was.
    const resume = relinkRef.current.resume;
    const el = mediaElementRef.current;
    if (resume && el) {
      relinkRef.current.resume = null;
      el.currentTime = resume.time;
      if (resume.playing) el.play().catch(() => {});
    }
  }, []);
  // The element, only once it has its file.
  const playableElement = useCallback(() => {
    const el = mediaElementRef.current;
    const url = mediaUrlRef.current;
    return el && url && loadedUrlRef.current === url ? el : null;
  }, []);

  // Get alignment token layer and tokens
  const alignmentTokenLayer = doc.layerInfo.alignmentTokenLayer;
  const alignmentTokens = doc.alignmentTokens || [];

  // Speech detection. Proposals live in the tab, never on the server, until
  // someone types into one. See useVadProposals.js for why.
  // The cuts ride on the document so they outlive the tab. A reader cannot
  // write them, and a failed write is not worth interrupting anyone over: the
  // proposals are still on screen either way.
  const persistCuts = useCallback(
    (payload) => {
      doc.setMetadataKeys({ [VAD_METADATA_KEY]: payload ?? null }).catch((err) => {
        console.error('Could not keep the detected cuts:', err);
      });
    },
    [doc],
  );
  const vad = useVadProposals({
    mediaBlob,
    mediaKey: mediaSrcUrl,
    alignmentTokens,
    params: detectSpot.params.coercedValues,
    methodKey: detectSpot.selection,
    saved: doc.storedMetadata[VAD_METADATA_KEY] ?? null,
    onPersist: canWrite ? persistCuts : null,
  });
  useMirroredProgress(detectRun, {
    percent: vad.progress > 0 ? vad.progress * 100 : null,
    message: 'Detecting speech…',
    active: detectRun.running && !detectSpot.service,
  });

  // Media playback operations. This is the player's ref callback, so it runs
  // at commit with the element, and again with null when the element goes.
  const setMediaElement = useCallback((element) => {
    mediaElementRef.current = element;
    setMediaElementState(element);
    // Apply the current volume to a freshly-registered element. This covers the
    // element mounting after the initial 0.8 (or a later value) was set, since
    // the `[volume]` effect below won't re-run just because the ref changed.
    if (element) {
      element.volume = volumeRef.current;
      // `defaultPlaybackRate` as well as `playbackRate`: the media load
      // algorithm resets `playbackRate` to the default when `src` is applied,
      // and never touches `volume`, which is why a remounted player came back
      // at 1× while the slider still read 0.50×. It recovered from
      // `loadedmetadata`, so this assignment was doing nothing whenever that
      // event did fire and nothing at all whenever it did not.
      element.defaultPlaybackRate = playbackRateRef.current;
      element.playbackRate = playbackRateRef.current;
    }
  }, []);

  const setAutoScrollToTime = useCallback((fn) => {
    autoScrollToTimeRef.current = fn;
  }, []);

  const handleTimeUpdate = setCurrentTime;
  const playingSelectionRef = useRef(playingSelection);
  playingSelectionRef.current = playingSelection;
  const loopSegmentRef = useRef(loopSegment);
  loopSegmentRef.current = loopSegment;

  // While playing, one loop reads the element's clock every frame into `clock`
  // and into React state no more often than RUNNING_TIME_MS, and ends a
  // stretch being played at its end. A seek made any
  // other way (a loop back to a segment's start, a keyboard seek) shows the
  // moment it lands, playing or not.
  useEffect(() => {
    const el = mediaElement;
    if (!el) return undefined;
    const sync = () => setCurrentTime(el.currentTime);
    el.addEventListener('seeked', sync);
    if (!isPlaying) {
      sync();
      return () => el.removeEventListener('seeked', sync);
    }
    let frame = null;
    let shownAt = 0;
    const tick = (now) => {
      // A stretch being played ends at its end: back to its start when
      // looping, else snapped to the end and paused.
      const range = playingSelectionRef.current;
      if (range && el.currentTime >= range.end) {
        if (loopSegmentRef.current) {
          el.currentTime = range.start;
        } else {
          el.currentTime = range.end;
          el.pause();
          setPlayingSelection(null);
          setCurrentTime(range.end);
          return;
        }
      }
      clock.set(el.currentTime);
      if (now - shownAt >= RUNNING_TIME_MS) {
        shownAt = now;
        setCurrentTimeState(el.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('seeked', sync);
    };
  }, [mediaElement, isPlaying, clock, setCurrentTime]);

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
    if (playableElement()) {
      mediaElementRef.current.pause();
      mediaElementRef.current.currentTime = 0;
      setCurrentTime(0);
      setPlayingSelection(null);
      // Auto-scroll timeline to beginning
      if (autoScrollToTimeRef.current) {
        autoScrollToTimeRef.current(0);
      }
    }
  }, [playableElement, setCurrentTime]);

  const handleSkipToEnd = useCallback(() => {
    if (playableElement() && duration) {
      mediaElementRef.current.pause();
      mediaElementRef.current.currentTime = duration;
      setCurrentTime(duration);
      setPlayingSelection(null);
      // Auto-scroll timeline to end
      if (autoScrollToTimeRef.current) {
        autoScrollToTimeRef.current(duration);
      }
    }
  }, [duration, playableElement, setCurrentTime]);

  // Play one stretch of the recording and stop (or loop) at its end. Setting
  // currentTime moves the official playback position at once, so play() picks
  // up from the new position without waiting for `seeked`. The returned
  // promise is ignored: a rejection here is the browser's autoplay policy, and
  // every caller runs from a user gesture.
  const playRange = useCallback(
    (range) => {
      const el = playableElement();
      if (!range || !el) return;
      el.currentTime = range.start;
      setCurrentTime(range.start);
      setPlayingSelection({ start: range.start, end: range.end });
      el.play().catch(() => {});
    },
    [playableElement, setCurrentTime],
  );

  // Play a stretch the way a transcriber expects of a segment they paused in:
  // on from where playback stopped when that is inside the stretch (pausing
  // to type must not throw the listener back to the start), from the start
  // when playback is elsewhere or already at the end. Stops at the end
  // either way.
  const playRangeFromHere = useCallback(
    (range) => {
      const el = playableElement();
      if (!range || !el) return;
      const at = el.currentTime;
      const inside = Number.isFinite(at) && at >= range.start && at < range.end - 0.05;
      if (!inside) {
        el.currentTime = range.start;
        setCurrentTime(range.start);
      }
      setPlayingSelection({ start: range.start, end: range.end });
      el.play().catch(() => {});
    },
    [playableElement, setCurrentTime],
  );

  const handlePlaySelection = useCallback(() => {
    if (selection) playRange(selection);
  }, [selection, playRange]);

  const pausePlayback = useCallback(() => {
    mediaElementRef.current?.pause();
  }, []);

  // Play from the playhead, or pause. Free playback (no range) never auto-stops.
  const togglePlayback = useCallback(() => {
    const el = playableElement();
    if (!el) return;
    if (isPlaying) {
      el.pause();
    } else {
      setPlayingSelection(null);
      el.play().catch(() => {});
    }
  }, [isPlaying, playableElement]);

  // Move playback by `delta` seconds, keeping it in the recording. Any range
  // being played is dropped: after a seek the user is listening freely.
  const seekBy = useCallback(
    (delta) => {
      const el = playableElement();
      if (!el) return;
      const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
      const t = Math.max(0, Math.min(max || 0, el.currentTime + delta));
      el.currentTime = t;
      setCurrentTime(t);
      setPlayingSelection(null);
      if (autoScrollToTimeRef.current) autoScrollToTimeRef.current(t);
    },
    [duration, playableElement, setCurrentTime],
  );

  const handlePlaybackRateChange = useCallback((rate) => {
    const value = clampRate(rate);
    playbackRateRef.current = value;
    setPlaybackRate(value);
    if (mediaElementRef.current) {
      mediaElementRef.current.defaultPlaybackRate = value;
      mediaElementRef.current.playbackRate = value;
    }
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
            'Failed to convert',
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
          notifySuccess('Media file uploaded');
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
        description: 'Removes the recording from this document. This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      }))
    ) {
      return;
    }

    ownDeleteRef.current = true;
    const ok = await doc.deleteMedia().finally(() => {
      ownDeleteRef.current = false;
    });
    if (ok) {
      notifySuccess('Media file deleted');
    }
  }, [doc, confirm]);

  // Stop for a transcription, from the dialog or the banner. The run's first
  // phases have no request to cancel: the wait for the edits made before it,
  // and the clearing of the old transcript. A Stop there ends the run before
  // the service is asked. Once it is asked, Stop asks the service to stop.
  const transcribeStopRef = useRef(null);
  const stopTranscribe = useCallback(async () => {
    const stop = transcribeStopRef.current;
    if (!stop) return;
    stop();
    await cancelRequest();
  }, [cancelRequest]);

  // ASR operations
  const handleTranscribe = useCallback(async () => {
    const service = transcribeSpot.service;
    if (!service) return;

    const serviceId = service.serviceId;
    const documentId = doc.document.id;

    if (!documentId) {
      notifyError('This document could not be found.', 'Failed to transcribe');
      return;
    }

    // One service run at a time. `requestService` refuses a second one and
    // returns nothing, and it used to do so AFTER the baseline had been wiped
    // to make room for a transcript that was never asked for. Speech detection
    // by a service is the run this one can collide with: it takes no write
    // lock, so the lock is not what keeps the two apart.
    if (isProcessing) {
      notifyError('Another service run is in progress.', 'Transcribe');
      return;
    }

    // Block on unmet required service arguments before doing any work.
    const missing = Object.values(transcribeSpot.params.errors);
    if (missing.length) {
      notifyError(missing[0], 'Missing required option');
      return;
    }

    // The request goes on the document as it is: the service puts each new
    // segment into the text in time order, skips a segment whose times
    // another already holds, and deletes nothing (N2-SERVICES-1). A fresh
    // transcript is the person's to make, by clearing the text first.

    // Find text, alignment token, and sentence token layers
    const primaryTextLayer = doc.layerInfo.primaryTextLayer;
    const alignmentTokenLayer = doc.layerInfo.alignmentTokenLayer;
    const sentenceTokenLayer = doc.layerInfo.sentenceTokenLayer;

    // Held for the whole run: the service writes into the document.
    const lock = acquireWriteLock('Transcribe', { onCancel: stopTranscribe });
    if (!lock) return;
    lockRef.current = lock;
    let stillOut = false; // the request survived our giving up on it
    let stopped = false;
    let asked = false; // the service was asked, so its answer ends the run
    let onStop;
    const stopping = new Promise((resolve) => {
      onStop = resolve;
    });
    transcribeStopRef.current = () => {
      stopped = true;
      transcribeRun.report({ percent: null, message: 'Stopping…' });
      lock.setStatus('Stopping…');
      onStop();
    };
    try {
      // Every write the ASR service makes is ONE logical operation in the
      // audit log: the open operation propagates to the service via the
      // request.
      // It is a service run naming the service, which the service's writes
      // keep when they join it.
      const label = `Transcribe audio (${service.serviceName || serviceId})`;
      transcribeRun.start(['Transcribe']);
      // The client holds one open operation, and an edit still saving holds
      // one: opened now, this run's would join it and be recorded as that
      // edit. The lock keeps new edits out, so the wait is for those already
      // made.
      await Promise.race([doc.whenSaved(), stopping]);
      if (stopped) {
        notifyInfo('Stopped. The transcript is unchanged.', 'Transcribe');
        return;
      }
      await doc.client.withOperation(
        label,
        async () => {
          if (stopped) return;
          transcribeRun.report({ message: 'Starting the service…' });
          asked = true;

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
              successMessage: 'Transcription complete',
              notice: transcribeNotice,
              errorTitle: 'Failed to transcribe',
              stoppedTitle: 'Transcribe',
              // Written down before submitting, so a reload can still find it.
              onRequestId: (requestId) =>
                writeRunRecord(documentId, {
                  requestId,
                  projectId: project.id,
                  label: 'Transcribe',
                }),
              timeout: TRANSCRIBE_TIMEOUT_MS,
              // The operation opened above, for this run.
              inOperation: true,
            },
          );
        },
        { kind: 'service-run', ref: serviceSource(serviceId) },
      );
      if (!asked) {
        notifyInfo('Stopped. The transcript is unchanged.', 'Transcribe');
        return;
      }

      // A full reload of a freshly transcribed document is seconds of work
      // with nothing else on screen to show for it, so it is named like any
      // other step rather than left as dead air.
      transcribeRun.report({ percent: null, message: 'Loading the transcript…' });
      lock.setStatus('Loading the transcript…');
      await reloadAfterRun(() => doc._reload());
    } catch (error) {
      console.error('Transcription failed:', error);
      // `pending` means the request is still out there. The client stopped
      // waiting and the service did not stop working, so keep the record for
      // a reload to rejoin.
      stillOut = error?.pending === true;
    } finally {
      if (!stillOut) clearRunRecord(documentId);
      transcribeStopRef.current = null;
      transcribeRun.finish();
      lock.release();
      lockRef.current = null;
    }
  }, [
    doc,
    project,
    requestService,
    isProcessing,
    transcribeSpot,
    transcribeRun,
    acquireWriteLock,
    stopTranscribe,
  ]);

  // Speech detection: the built-in runs in this tab, a service returns regions
  // that land in the same proposal list. Either way nothing is written until
  // somebody types into a proposal, so this run takes NO write lock — typing
  // into a proposal IS how it is accepted, and locking would break the gesture
  // the feature exists for.
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
    // One service run at a time, the same guard Transcribe carries. Without
    // it the dialog opened its progress row and the proposal list went to
    // "running", `requestService` refused and returned nothing, and the run
    // ended a beat later saying nothing at all.
    if (isProcessing) {
      notifyError('Another service run is in progress.', 'Detect speech');
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
          errorTitle: 'Failed to detect speech',
          errorMessage: `${service.serviceName} reported an error.`,
          stoppedTitle: 'Speech detection',
          // Detection writes nothing: a segment is a stretch of the baseline
          // and cannot exist without text, so there is nothing to have kept.
          stoppedMessage: 'Stopped. The proposals on the document are unchanged.',
          // And it writes down no run, so a reload would find nothing to rejoin.
          lostMessage: 'Lost contact with the service.',
        },
      );
      // A stopped run carries no regions, and a refused one is not a result at
      // all. Either taken as an empty list would read as "no speech found" and
      // wipe the proposals the document already had.
      if (!result || result.stopped === true) {
        vad.abandonServiceRun();
        return;
      }
      // A detect-speech service RETURNS its regions and writes nothing: a
      // segment is a stretch of the baseline and cannot exist without text.
      vad.acceptServiceRegions(result.segments ?? result.proposals ?? []);
    } catch (error) {
      // A lost connection is not a failed detection: the run may still be out
      // there, and the proposals already on the document are untouched either
      // way. The request hook has said so, so leave the dialog as it was.
      if (error?.pending) vad.abandonServiceRun();
      else vad.failRun(error?.message ?? String(error));
    } finally {
      detectRun.finish();
    }
  }, [detectSpot, detectRun, vad, requestService, isProcessing, project, doc]);

  // Deleting a segment takes its text with it by default: a segment IS its
  // utterance, and the row asks first only when annotations are built on that
  // text (see SegmentRow). Keeping the text is the row's other answer.
  const handleDeleteAlignment = useCallback(
    async (alignmentId, { deleteText = true } = {}) => {
      const ok = await doc.deleteAlignment(alignmentId, { deleteText });
      if (ok && deleteText) notifySuccess('Segment and its text deleted', 'Deleted');
      return ok;
    },
    [doc],
  );

  // Keep the DOM media element's volume in sync with `volume`. Covers the
  // initial 0.8, any volume set before the element mounted, and element swaps.
  useEffect(() => {
    volumeRef.current = volume;
    if (mediaElementRef.current) mediaElementRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    playbackRateRef.current = playbackRate;
    if (mediaElementRef.current) {
      mediaElementRef.current.defaultPlaybackRate = playbackRate;
      mediaElementRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Hotkeys, ignoring events from form fields.
  useEffect(() => {
    const onKeyDown = (e) => {
      // Shift+Left / Shift+Right seek one second, in a text box or out of one,
      // so a transcriber can re-hear a stretch without leaving the row. Shift
      // for the same reason as Shift+Space: Ctrl+Arrow is Mission Control on a
      // Mac and Cmd+Arrow is line start/end in every text box, while Shift is
      // the one modifier every platform leaves alone. Inside a row this costs
      // extending a selection by one character, and nothing else. Only the
      // tab's own boxes pay that (see takesMediaKeys): this listener is on the
      // document, and a Shift+Arrow typed into a dialog or the assistant was
      // seeking the recording instead of selecting.
      const seek = keys.which(['media.seekBack', 'media.seekForward'], e);
      if (seek && (!isTextTarget(e.target) || takesMediaKeys(e.target))) {
        e.preventDefault();
        seekBy(seek === 'media.seekBack' ? -1 : 1);
        return;
      }
      // Shift+Space pauses, or plays the selected stretch on from where it
      // stopped, outside a text box.
      // (Inside one, the row handles it for its own segment.) Shift because
      // it is the one modifier every platform leaves alone: Ctrl+Space and
      // Cmd+Space belong to macOS, Alt+Space to Windows and GNOME.
      if (keys.is('media.playSegment', e) && !isTextTarget(e.target) && !isActivatable(e.target)) {
        e.preventDefault();
        const el = playableElement();
        if (!el) return;
        if (isPlaying) el.pause();
        else if (selection) playRangeFromHere(selection);
        else el.play().catch(() => {});
        return;
      }
      if (isTextTarget(e.target) || isActivatable(e.target)) return;
      // Chords match their modifiers exactly, so one carrying a modifier that
      // is somebody else's (Ctrl+Space is input-source switching on a Mac,
      // Alt+Space a window menu) never toggles playback on the way through.
      // ESC key to clear selection
      if (e.key === 'Escape' && !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) {
        if (selection) {
          setSelection(null);
          setPopoverOpened(false);
        }
      } else if (keys.is('media.playPause', e)) {
        // Space key to toggle playback
        e.preventDefault();
        const el = playableElement();
        if (el) {
          if (isPlaying) {
            el.pause();
          } else {
            // Swallowed like every other play() here: a rejection is the
            // browser's autoplay policy, and this one runs from a keystroke.
            el.play().catch(() => {});
          }
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selection, isPlaying, playRangeFromHere, seekBy, playableElement]);

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
    relinkMedia,
    retryMedia,
    mediaBlob,
    mediaBlobKey,
    isLoadingMedia,
    mediaLoadError,
    alignmentTokenLayer,
    alignmentTokens,

    // Media state
    mediaElement,
    mediaReady,
    currentTime,
    setCurrentTime,
    clock,
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
    handleMediaLoaded,
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
    cancelRequest,
    stopTranscribe,
    handleTranscribe,
    handleDetectSpeech,

    // Service discovery
    discoverServices,
    isDiscovering,
    availableServices,
    hasServices,

    // Refs
    mediaElementRef,
  };
};
