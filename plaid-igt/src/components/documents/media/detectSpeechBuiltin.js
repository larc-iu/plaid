import { BUILTIN_DETECT_SPEECH_SILERO } from '@/domain/serviceDefaults';
import { VAD_DEFAULTS } from '@/domain/vad/speechTimestamps.js';
import { msg, t } from '@ui/lib/i18n.js';

// The in-browser Silero detector, described the way a registered service
// describes itself, so it sits in the same list as one and renders through the
// same parameter form. Anyone may register a `detect-speech` service and it
// appears beside this.
//
// The maximum is 20 s where upstream leaves it unbounded: a proposal is an
// utterance somebody has to type into, so an unbroken five-minute block would
// be a proposal nobody can use. The model splits an over-long stretch at the
// widest silence inside it, which is the cut a person would have made anyway.
//
// Its labels are messages: `detectSpeechBuiltin()` is the description in the
// interface's language, for the method list and the form.
export const DETECT_SPEECH_BUILTIN = {
  name: BUILTIN_DETECT_SPEECH_SILERO,
  label: msg('Default'),
  description: 'Silero', // i18n-ignore: the model's name
  schema: [
    {
      key: 'threshold',
      label: msg('Speech threshold'),
      description: msg(
        'Model confidence. Lower catches quiet talk, and also breaths and background noise.',
      ),
      type: 'number',
      slider: true,
      min: 0.1,
      max: 0.9,
      step: 0.05,
      default: VAD_DEFAULTS.threshold,
    },
    {
      key: 'minSilenceDurationMs',
      label: msg('Shortest silence (ms)'),
      description: msg('A pause shorter than this does not end a segment.'),
      type: 'number',
      min: 0,
      max: 5000,
      step: 10,
      default: VAD_DEFAULTS.minSilenceDurationMs,
    },
    {
      key: 'minSpeechDurationMs',
      label: msg('Shortest segment (ms)'),
      description: msg('Anything shorter is left out.'),
      type: 'number',
      min: 0,
      max: 5000,
      step: 10,
      default: VAD_DEFAULTS.minSpeechDurationMs,
    },
    {
      key: 'maxSpeechDurationS',
      label: msg('Longest segment (s)'),
      description: msg('A segment longer than this is cut at the widest silence inside it.'),
      type: 'number',
      min: 1,
      max: 600,
      step: 1,
      default: 20,
    },
    {
      key: 'speechPadMs',
      label: msg('Padding (ms)'),
      description: msg('Added to each end of every segment.'),
      type: 'number',
      min: 0,
      max: 1000,
      step: 10,
      default: VAD_DEFAULTS.speechPadMs,
    },
  ],
};

/** DETECT_SPEECH_BUILTIN with its labels and descriptions translated. */
export const detectSpeechBuiltin = () => ({
  ...DETECT_SPEECH_BUILTIN,
  label: t(DETECT_SPEECH_BUILTIN.label),
  schema: DETECT_SPEECH_BUILTIN.schema.map((param) => ({
    ...param,
    label: t(param.label),
    description: t(param.description),
  })),
});

// Everything the detector reads, with the app's defaults under whatever the
// form has set.
export const detectorParams = (values) => ({
  ...VAD_DEFAULTS,
  maxSpeechDurationS: 20,
  ...values,
});
