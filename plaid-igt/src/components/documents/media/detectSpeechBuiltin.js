import { BUILTIN_DETECT_SPEECH_SILERO } from '@/domain/serviceDefaults';
import { VAD_DEFAULTS } from '@/domain/vad/speechTimestamps.js';

// The in-browser Silero detector, described the way a registered service
// describes itself, so it sits in the same list as one and renders through the
// same parameter form. Anyone may register a `detect-speech` service and it
// appears beside this.
//
// The maximum is 20 s where upstream leaves it unbounded: a proposal is an
// utterance somebody has to type into, so an unbroken five-minute block would
// be a proposal nobody can use. The model splits an over-long stretch at the
// widest silence inside it, which is the cut a person would have made anyway.
export const DETECT_SPEECH_BUILTIN = {
  name: BUILTIN_DETECT_SPEECH_SILERO,
  label: 'Default',
  description: 'Silero',
  schema: [
    {
      key: 'threshold',
      label: 'Speech threshold',
      description:
        'Model confidence. Lower catches quiet talk, and also breaths and background noise.',
      type: 'number',
      slider: true,
      min: 0.1,
      max: 0.9,
      step: 0.05,
      default: VAD_DEFAULTS.threshold,
    },
    {
      key: 'minSilenceDurationMs',
      label: 'Shortest silence (ms)',
      description: 'A pause shorter than this does not end a segment.',
      type: 'number',
      min: 0,
      max: 5000,
      step: 10,
      default: VAD_DEFAULTS.minSilenceDurationMs,
    },
    {
      key: 'minSpeechDurationMs',
      label: 'Shortest segment (ms)',
      description: 'Anything shorter is left out.',
      type: 'number',
      min: 0,
      max: 5000,
      step: 10,
      default: VAD_DEFAULTS.minSpeechDurationMs,
    },
    {
      key: 'maxSpeechDurationS',
      label: 'Longest segment (s)',
      description: 'A segment longer than this is cut at the widest silence inside it.',
      type: 'number',
      min: 1,
      max: 600,
      step: 1,
      default: 20,
    },
    {
      key: 'speechPadMs',
      label: 'Padding (ms)',
      description: 'Added to each end of every segment.',
      type: 'number',
      min: 0,
      max: 1000,
      step: 10,
      default: VAD_DEFAULTS.speechPadMs,
    },
  ],
};

// Everything the detector reads, with the app's defaults under whatever the
// form has set.
export const detectorParams = (values) => ({
  ...VAD_DEFAULTS,
  maxSpeechDurationS: 20,
  ...values,
});
