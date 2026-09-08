// Turning a per-frame speech probability into segment boundaries.
//
// This is a faithful port of `get_speech_timestamps` from silero-vad's
// `utils_vad.py` (MIT). Keeping it faithful is the point: the linguists this
// serves also run Praat, whose `Sound: To TextGrid (speech activity, Silero)...`
// drives the same model, and a first pass that cut differently in the two
// tools would be worse than no first pass. Divergence from upstream is a bug
// here, not a preference. Check against the reference before touching the
// state machine, and see speechTimestamps.test.js, whose fixtures are recorded
// from the Python original.
//
// The frame loop that produces `probs` lives in sileroVad.js. This file is
// pure so it can be tested without a model: probabilities in, sample offsets
// out.

/** Samples per frame at 16 kHz. The model accepts no other window. */
export const WINDOW_SAMPLES = 512;
export const SAMPLE_RATE = 16000;

/**
 * Upstream's defaults, in the units the UI speaks. `maxSpeechDurationS` is
 * Infinity upstream. The Media tab overrides it, since a proposal longer than
 * an utterance is not a proposal anyone can type into.
 */
export const VAD_DEFAULTS = {
  threshold: 0.5,
  minSpeechDurationMs: 250,
  maxSpeechDurationS: Infinity,
  minSilenceDurationMs: 100,
  speechPadMs: 30,
  minSilenceAtMaxSpeechMs: 98,
};

/**
 * Speech regions in `probs`, as `[{start, end}]` in SAMPLES at 16 kHz.
 *
 * `probs[i]` is the model's probability that frame i (samples
 * `[i*512, i*512+512)`) is speech. `audioLengthSamples` is the true length of
 * the audio, which is shorter than `probs.length * 512` when the last frame
 * was zero-padded.
 */
export function speechTimestamps(probs, audioLengthSamples, options = {}) {
  const {
    threshold,
    minSpeechDurationMs,
    maxSpeechDurationS,
    minSilenceDurationMs,
    speechPadMs,
    minSilenceAtMaxSpeechMs,
  } = { ...VAD_DEFAULTS, ...options };

  const negThreshold = options.negThreshold ?? Math.max(threshold - 0.15, 0.01);

  const minSpeechSamples = (SAMPLE_RATE * minSpeechDurationMs) / 1000;
  const speechPadSamples = (SAMPLE_RATE * speechPadMs) / 1000;
  const maxSpeechSamples = SAMPLE_RATE * maxSpeechDurationS - WINDOW_SAMPLES - 2 * speechPadSamples;
  const minSilenceSamples = (SAMPLE_RATE * minSilenceDurationMs) / 1000;
  const minSilenceSamplesAtMaxSpeech = (SAMPLE_RATE * minSilenceAtMaxSpeechMs) / 1000;

  let triggered = false;
  const speeches = [];
  let current = null;
  // The last frame that dropped below negThreshold while in speech, so a short
  // silence inside an utterance does not end it.
  let tempEnd = 0;
  // Fallback cut points for when a segment runs past maxSpeechSamples.
  let prevEnd = 0;
  let nextStart = 0;
  let possibleEnds = [];

  for (let i = 0; i < probs.length; i++) {
    const speechProb = probs[i];
    const curSample = WINDOW_SAMPLES * i;

    // Speech came back after a candidate end: bank the silence we just crossed
    // as a place the max-length cut could fall, and forget the candidate.
    if (speechProb >= threshold && tempEnd) {
      const silDur = curSample - tempEnd;
      if (silDur > minSilenceSamplesAtMaxSpeech) possibleEnds.push([tempEnd, silDur]);
      tempEnd = 0;
      if (nextStart < prevEnd) nextStart = curSample;
    }

    if (speechProb >= threshold && !triggered) {
      triggered = true;
      current = { start: curSample };
      continue;
    }

    // Too long: cut at the widest silence seen inside this stretch.
    if (triggered && curSample - current.start > maxSpeechSamples) {
      if (possibleEnds.length) {
        let best = possibleEnds[0];
        for (const candidate of possibleEnds) if (candidate[1] > best[1]) best = candidate;
        const [end, dur] = best;
        prevEnd = end;
        current.end = end;
        speeches.push(current);
        current = null;
        nextStart = prevEnd + dur;

        if (nextStart < prevEnd + curSample) {
          current = { start: nextStart };
        } else {
          triggered = false;
        }
        prevEnd = nextStart = tempEnd = 0;
        possibleEnds = [];
      } else {
        // Nothing to cut at: end it here.
        current.end = curSample;
        speeches.push(current);
        current = null;
        prevEnd = nextStart = tempEnd = 0;
        triggered = false;
        possibleEnds = [];
        continue;
      }
    }

    if (speechProb < negThreshold && triggered) {
      if (!tempEnd) tempEnd = curSample;
      const silDurNow = curSample - tempEnd;
      if (silDurNow < minSilenceSamples) continue;
      current.end = tempEnd;
      if (current.end - current.start > minSpeechSamples) speeches.push(current);
      current = null;
      prevEnd = nextStart = tempEnd = 0;
      triggered = false;
      possibleEnds = [];
      continue;
    }
  }

  if (current && audioLengthSamples - current.start > minSpeechSamples) {
    current.end = audioLengthSamples;
    speeches.push(current);
  }

  // Pad each side, splitting the gap when two segments are closer than twice
  // the padding so the padded segments still do not touch.
  for (let i = 0; i < speeches.length; i++) {
    const speech = speeches[i];
    if (i === 0) speech.start = Math.trunc(Math.max(0, speech.start - speechPadSamples));
    if (i !== speeches.length - 1) {
      const silenceDuration = speeches[i + 1].start - speech.end;
      if (silenceDuration < 2 * speechPadSamples) {
        const half = Math.floor(silenceDuration / 2);
        speech.end += half;
        speeches[i + 1].start = Math.trunc(Math.max(0, speeches[i + 1].start - half));
      } else {
        speech.end = Math.trunc(Math.min(audioLengthSamples, speech.end + speechPadSamples));
        speeches[i + 1].start = Math.trunc(Math.max(0, speeches[i + 1].start - speechPadSamples));
      }
    } else {
      speech.end = Math.trunc(Math.min(audioLengthSamples, speech.end + speechPadSamples));
    }
  }

  return speeches;
}

/** The same regions in SECONDS, which is what alignment metadata stores. */
export const toSeconds = (speeches) =>
  speeches.map(({ start, end }) => ({
    timeBegin: start / SAMPLE_RATE,
    timeEnd: end / SAMPLE_RATE,
  }));
