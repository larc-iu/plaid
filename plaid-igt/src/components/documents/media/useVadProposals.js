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
// the Analyze grid, the validators) ever sees a segment without text. Nothing
// is written to the server by detection itself.
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

/**
 * @param {Blob|null} mediaBlob     the recording, already fetched for playback
 * @param {string|null} mediaKey    changes when the recording does, to drop the analysis
 * @param {Array} alignmentTokens   existing segments, which proposals never overlap
 * @param {Object} params           the built-in detector's coerced options
 * @param {string} methodKey        the chosen method, so a switch drops what
 *                                  the previous one proposed
 */
export function useVadProposals({ mediaBlob, mediaKey, alignmentTokens, params, methodKey }) {
  const [analysis, setAnalysis] = useState(null); // { probs, lengthSamples }, built-in only
  const [serviceRegions, setServiceRegions] = useState(null); // [{timeBegin,timeEnd,speaker?}]
  const [status, setStatus] = useState('idle'); // idle | running | ready | error
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [dismissed, setDismissed] = useState(() => new Set());
  const abortRef = useRef(null);

  // A replaced recording invalidates everything measured from the old one, and
  // so does a change of method: a proposal belongs to whatever produced it, and
  // leaving the last method's cuts under this one's controls would be a lie.
  useEffect(() => {
    setAnalysis(null);
    setServiceRegions(null);
    setStatus('idle');
    setError(null);
    setDismissed(new Set());
  }, [mediaKey, methodKey]);

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

  const { proposals, foundCount } = useMemo(() => {
    const regions =
      serviceRegions ??
      (analysis
        ? toSeconds(
            speechTimestamps(analysis.probs, analysis.lengthSamples, detectorParams(derivedFrom)),
          )
        : null);
    if (!regions) return { proposals: [], foundCount: 0 };
    const tokens = alignmentTokens || [];
    return {
      foundCount: regions.length,
      proposals: regions
        .map((r) => ({ id: `vad-${r.timeBegin.toFixed(3)}-${r.timeEnd.toFixed(3)}`, ...r }))
        .filter((p) => !dismissed.has(p.id))
        .filter(
          (p) => !tokens.some((t) => timeBeginOf(t) < p.timeEnd && timeEndOf(t) > p.timeBegin),
        ),
    };
  }, [analysis, serviceRegions, derivedFrom, dismissed, alignmentTokens]);

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
    failRun,
    cancel,
    clear,
    dismiss,
  };
}
