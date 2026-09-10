import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { speechProbabilities } from '../../../domain/vad/speechProbabilities.js';
import { speechTimestamps, toSeconds } from '../../../domain/vad/speechTimestamps.js';
import { detectorParams } from './detectSpeechBuiltin.js';

// Speech detection as PROPOSALS, not as data.
//
// A cut with no text has nowhere to live: `createAlignment` requires non-empty
// text, because a segment IS a stretch of the baseline (see
// mutations/alignment.js). So a detected region stays here, in the tab's own
// state, until a linguist types into it and presses Enter. Then it becomes an
// ordinary segment by the ordinary path, and nothing downstream (the exports,
// the Analyze grid, the validators) ever sees a segment without text.
//
// The cuts themselves are KEPT, under `speechDetection` in the document's
// metadata, so leaving the tab does not throw the segmentation away and it can
// be transcribed another day, or by somebody else. They are still proposals:
// no segment exists, nothing is exported, and discarding them removes the key.
// Only the regions are kept, never the model's per-frame probabilities, which
// run to megabytes; restored cuts therefore behave like a service's, fixed
// until Detect runs again.
//
// That is also why `detect-speech` is the one task whose services RETURN their
// regions instead of writing them: a service's proposals land here, in the same
// place and under the same rules as the built-in's.
//
// The built-in model runs ONCE per recording. Its per-frame probabilities do
// not depend on any parameter, so moving a slider re-derives the proposals from
// the cached probabilities in well under a frame. Detect is slow, tuning is free.

const timeBeginOf = (t) => t.metadata?.timeBegin ?? 0;
const timeEndOf = (t) => t.metadata?.timeEnd ?? timeBeginOf(t);

/** Where the cuts are kept on the document. */
export const VAD_METADATA_KEY = 'speechDetection';

// Long enough that dragging a slider or discarding a run of proposals settles
// into one write, short enough that leaving the tab straight after a detection
// still keeps it.
const PERSIST_DELAY_MS = 1500;

// What is stored, in one shape both the writer and the restore check build, so
// they can be compared as strings. The recording is identified by its exact
// byte length: replacing it leaves cuts measured from something else behind.
// The regions go into the document's metadata as one flat list of numbers,
// begin and end in turn, with the speakers (a service may name them) in a
// parallel list only when there are any. The server caps a metadata payload
// at 500 keys counted through every level of nesting, and a list of
// {timeBegin, timeEnd} objects spent two per region: a 39-minute recording's
// 300 cuts could not be saved at all ("Metadata exceeds max key count").
// Numbers in a list cost no keys.
const packRegions = (regions) => {
  const times = [];
  const speakers = [];
  for (const r of regions) {
    times.push(Number(r.timeBegin.toFixed(3)), Number(r.timeEnd.toFixed(3)));
    speakers.push(r.speaker ?? null);
  }
  return speakers.some((sp) => sp != null) ? { regions: times, speakers } : { regions: times };
};

const unpackRegions = (kept) => {
  const times = Array.isArray(kept?.regions) ? kept.regions : [];
  const out = [];
  for (let i = 0; i + 1 < times.length; i += 2) {
    const speaker = kept.speakers?.[i / 2] ?? undefined;
    out.push({ timeBegin: times[i], timeEnd: times[i + 1], ...(speaker ? { speaker } : {}) });
  }
  return out.length ? out : null;
};

const payloadOf = (mediaBlob, methodKey, regions, dismissed) =>
  regions && regions.length
    ? {
        mediaBytes: mediaBlob?.size ?? null,
        method: methodKey ?? null,
        ...packRegions(regions),
        dismissed: [...dismissed].sort(),
      }
    : null;

/**
 * @param {Blob|null} mediaBlob     the recording, already fetched for playback
 * @param {string|null} mediaKey    changes when the recording does, to drop the analysis
 * @param {Array} alignmentTokens   existing segments, which proposals never overlap
 * @param {Object} params           the built-in detector's coerced options
 * @param {string} methodKey        the chosen method, so a switch drops what
 *                                  the previous one proposed
 * @param {Object|null} saved       what an earlier session left on the document
 * @param {Function} onPersist      given the payload to keep, or null to drop it
 */
export function useVadProposals({
  mediaBlob,
  mediaKey,
  alignmentTokens,
  params,
  methodKey,
  saved = null,
  onPersist = null,
}) {
  const [analysis, setAnalysis] = useState(null); // { probs, lengthSamples }, built-in only
  const [serviceRegions, setServiceRegions] = useState(null); // [{timeBegin,timeEnd,speaker?}]
  const [status, setStatus] = useState('idle'); // idle | running | ready | error
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [dismissed, setDismissed] = useState(() => new Set());
  const abortRef = useRef(null);

  // Read only when the recording or the method changes. As a dependency it
  // would fire on our own write and undo whatever happened since.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  // The payload the document already holds, so an unchanged one is not written
  // back. Set at restore, and again after every write.
  const writtenRef = useRef(null);
  // A write waiting out its delay, kept so leaving the tab can send it.
  const pendingRef = useRef(null);
  const flush = useCallback(() => {
    const next = pendingRef.current;
    if (!next) return;
    pendingRef.current = null;
    writtenRef.current = next.encoded;
    persistRef.current?.(next.payload);
  }, []);

  // A replaced recording invalidates everything measured from the old one, and
  // so does a change of method: a proposal belongs to whatever produced it, and
  // leaving the last method's cuts under this one's controls would be a lie.
  // What the document kept for THIS recording and method is restored instead.
  useEffect(() => {
    const kept = savedRef.current;
    const mine =
      kept && kept.mediaBytes === (mediaBlob?.size ?? null) && kept.method === (methodKey ?? null)
        ? kept
        : null;
    const restored = mine ? unpackRegions(mine) : null;
    setAnalysis(null);
    setServiceRegions(restored);
    setStatus(restored ? 'ready' : 'idle');
    setError(null);
    setDismissed(new Set(mine?.dismissed ?? []));
    writtenRef.current = JSON.stringify(
      payloadOf(mediaBlob, methodKey, restored, new Set(mine?.dismissed ?? [])),
    );
  }, [mediaKey, methodKey, mediaBlob]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // The built-in: decode, run the model, keep the probabilities.
  const detect = useCallback(async () => {
    if (!mediaBlob) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('running');
    setProgress(0);
    setError(null);
    setDismissed(new Set());
    setServiceRegions(null);
    try {
      const result = await speechProbabilities(mediaBlob, {
        onProgress: setProgress,
        signal: controller.signal,
      });
      if (controller.signal.aborted || !result) {
        setStatus(analysis ? 'ready' : 'idle');
        return;
      }
      setAnalysis(result);
      setStatus('ready');
    } catch (e) {
      console.error('Speech detection failed:', e);
      setError(e?.message ?? String(e));
      setStatus('error');
    }
    // `analysis` is read only to decide what to fall back to on cancel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaBlob]);

  // A `detect-speech` service's regions, taken as proposals like the model's.
  // Times are seconds; a region without a usable pair is dropped rather than
  // becoming a zero-length proposal nobody can type into.
  const acceptServiceRegions = useCallback((segments) => {
    const regions = (segments || [])
      .map((s) => ({
        timeBegin: Number(s.timeBegin ?? s.time_begin),
        timeEnd: Number(s.timeEnd ?? s.time_end),
        speaker: s.speaker ?? undefined,
      }))
      .filter((r) => Number.isFinite(r.timeBegin) && Number.isFinite(r.timeEnd))
      .filter((r) => r.timeEnd > r.timeBegin)
      .sort((a, b) => a.timeBegin - b.timeBegin);
    setAnalysis(null);
    setDismissed(new Set());
    setServiceRegions(regions);
    setStatus('ready');
    setError(null);
  }, []);

  const beginServiceRun = useCallback(() => {
    setStatus('running');
    setError(null);
    setProgress(0);
  }, []);

  const failRun = useCallback((message) => {
    setError(message);
    setStatus('error');
  }, []);

  // A service run that produced nothing to take: it was stopped, or it never
  // started. NOT the same as finding no speech: `acceptServiceRegions([])`
  // would replace the proposals already on the document with an empty list and
  // then say "No speech found". The run just ends and everything stays put.
  const abandonServiceRun = useCallback(() => {
    setError(null);
    setServiceRegions((regions) => {
      setStatus(regions ? 'ready' : 'idle');
      return regions;
    });
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setAnalysis(null);
    setServiceRegions(null);
    setStatus('idle');
    setError(null);
    setDismissed(new Set());
  }, []);

  const dismiss = useCallback((id) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  // Derived on every parameter change, which is why the model's output is kept
  // rather than its verdict. An accepted proposal disappears here for free: it
  // became a segment covering the same stretch of time, and a proposal that
  // meets a segment is dropped.
  // Re-deriving is cheap, but re-rendering several hundred proposal rows is
  // not, and a slider drag fires a change per pointer move. Deferring the
  // parameters the derivation reads keeps the control itself at full speed and
  // lets React abandon a list render the next move has already superseded.
  const derivedFrom = useDeferredValue(params);

  const { proposals, foundCount, regions } = useMemo(() => {
    const found =
      serviceRegions ??
      (analysis
        ? toSeconds(
            speechTimestamps(analysis.probs, analysis.lengthSamples, detectorParams(derivedFrom)),
          )
        : null);
    if (!found) return { proposals: [], foundCount: 0, regions: null };
    const tokens = alignmentTokens || [];
    return {
      regions: found,
      foundCount: found.length,
      proposals: found
        .map((r) => ({ id: `vad-${r.timeBegin.toFixed(3)}-${r.timeEnd.toFixed(3)}`, ...r }))
        .filter((p) => !dismissed.has(p.id))
        .filter(
          (p) => !tokens.some((t) => timeBeginOf(t) < p.timeEnd && timeEndOf(t) > p.timeBegin),
        ),
    };
  }, [analysis, serviceRegions, derivedFrom, dismissed, alignmentTokens]);

  // Keep what was found, so leaving the tab is not the end of the segmentation.
  // A proposal that has BECOME a segment is not filtered out here: the segment
  // covers its stretch of time, so the filter above drops it again on the way
  // back in, and nothing has to be rewritten each time one is typed into.
  useEffect(() => {
    if (!onPersist) return undefined;
    const payload = payloadOf(mediaBlob, methodKey, regions, dismissed);
    const encoded = JSON.stringify(payload);
    if (encoded === writtenRef.current) {
      pendingRef.current = null;
      return undefined;
    }
    pendingRef.current = { encoded, payload };
    const timer = setTimeout(flush, PERSIST_DELAY_MS);
    return () => clearTimeout(timer);
    // persistRef and writtenRef are refs; onPersist is read only for its presence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions, dismissed, methodKey, mediaBlob, !!onPersist, flush]);

  // Leaving the tab is exactly the moment the cuts used to be lost, so a write
  // still inside its delay goes out on the way rather than being cancelled.
  useEffect(() => () => flush(), [flush]);

  return {
    proposals,
    // What detection found before anything was accepted or discarded, so the
    // dialog can tell an empty recording from one whose proposals are all used up.
    foundCount,
    hasAnalysis: !!analysis || !!serviceRegions,
    status,
    progress,
    error,
    detect,
    acceptServiceRegions,
    beginServiceRun,
    abandonServiceRun,
    failRun,
    cancel,
    clear,
    dismiss,
  };
}
