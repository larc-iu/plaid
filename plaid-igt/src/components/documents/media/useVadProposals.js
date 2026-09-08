import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { speechProbabilities } from '../../../domain/vad/speechProbabilities.js';
import { speechTimestamps, toSeconds, VAD_DEFAULTS } from '../../../domain/vad/speechTimestamps.js';

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
// The model runs ONCE per recording. Its per-frame probabilities do not depend
// on any parameter below, so moving a slider re-derives the proposals from the
// cached probabilities in well under a frame. Detect is slow, tuning is free.

const PARAMS_KEY = 'plaid_igt_vad_params';

// Upstream leaves the maximum unbounded. A segment here is an utterance
// somebody has to type into, so an unbroken five-minute block would be a
// proposal nobody can use. The model splits an over-long stretch at the widest
// silence inside it, which is the cut a person would have made anyway.
export const VAD_UI_DEFAULTS = { ...VAD_DEFAULTS, maxSpeechDurationS: 20 };

const readParams = () => {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (!raw) return VAD_UI_DEFAULTS;
    const stored = JSON.parse(raw);
    // Only known keys, only numbers: a hand-edited store cannot inject options.
    const clean = {};
    for (const key of Object.keys(VAD_UI_DEFAULTS)) {
      if (typeof stored[key] === 'number' && Number.isFinite(stored[key])) clean[key] = stored[key];
    }
    return { ...VAD_UI_DEFAULTS, ...clean };
  } catch {
    return VAD_UI_DEFAULTS;
  }
};

const timeBeginOf = (t) => t.metadata?.timeBegin ?? 0;
const timeEndOf = (t) => t.metadata?.timeEnd ?? timeBeginOf(t);

/**
 * @param {Blob|null} mediaBlob     the recording, already fetched for playback
 * @param {string|null} mediaKey    changes when the recording does, to drop the analysis
 * @param {Array} alignmentTokens   existing segments, which proposals never overlap
 */
export function useVadProposals({ mediaBlob, mediaKey, alignmentTokens }) {
  const [params, setParams] = useState(readParams);
  const [analysis, setAnalysis] = useState(null); // { probs, lengthSamples }
  const [status, setStatus] = useState('idle'); // idle | running | ready | error
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [dismissed, setDismissed] = useState(() => new Set());
  const abortRef = useRef(null);

  // A replaced recording invalidates everything measured from the old one.
  useEffect(() => {
    setAnalysis(null);
    setStatus('idle');
    setError(null);
    setDismissed(new Set());
  }, [mediaKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const detect = useCallback(async () => {
    if (!mediaBlob) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('running');
    setProgress(0);
    setError(null);
    setDismissed(new Set());
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

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setAnalysis(null);
    setStatus('idle');
    setError(null);
    setDismissed(new Set());
  }, []);

  const setParam = useCallback((name, value) => {
    setParams((prev) => {
      const next = { ...prev, [name]: value };
      try {
        localStorage.setItem(PARAMS_KEY, JSON.stringify(next));
      } catch {
        // A full or blocked store only loses the settings for next time.
      }
      return next;
    });
  }, []);

  const resetParams = useCallback(() => {
    setParams(VAD_UI_DEFAULTS);
    try {
      localStorage.removeItem(PARAMS_KEY);
    } catch {
      // Nothing to undo.
    }
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
    if (!analysis) return { proposals: [], foundCount: 0 };
    const regions = toSeconds(
      speechTimestamps(analysis.probs, analysis.lengthSamples, derivedFrom),
    );
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
  }, [analysis, derivedFrom, dismissed, alignmentTokens]);

  return {
    params,
    setParam,
    resetParams,
    proposals,
    // What detection found before anything was accepted or discarded, so the
    // card can tell an empty recording from one whose proposals are all used up.
    foundCount,
    hasAnalysis: !!analysis,
    status,
    progress,
    error,
    detect,
    cancel,
    clear,
    dismiss,
  };
}
