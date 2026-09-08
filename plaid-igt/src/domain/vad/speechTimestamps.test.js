import { describe, it, expect } from 'vitest';
import { speechTimestamps, toSeconds, SAMPLE_RATE } from './speechTimestamps.js';
import fixture from './speechTimestamps.fixture.json';

// The fixture is RECORDED from silero-vad's own `get_speech_timestamps`
// (Python, silero-vad 6.2.1): 60 s of real speech run through the model, the
// probabilities rounded to 4 dp, then the upstream post-processing run over
// those same rounded probabilities under five parameter sets. So a failure
// here means this port has drifted from the reference, which is the one thing
// it must not do. Regenerate rather than adjust the expectations.
describe('speechTimestamps', () => {
  const probs = Float32Array.from(fixture.probs);

  // Python names them with underscores, the port takes camelCase.
  const asOptions = (o) => ({
    ...(o.threshold !== undefined && { threshold: o.threshold }),
    ...(o.min_speech_duration_ms !== undefined && {
      minSpeechDurationMs: o.min_speech_duration_ms,
    }),
    ...(o.max_speech_duration_s !== undefined && { maxSpeechDurationS: o.max_speech_duration_s }),
    ...(o.min_silence_duration_ms !== undefined && {
      minSilenceDurationMs: o.min_silence_duration_ms,
    }),
    ...(o.speech_pad_ms !== undefined && { speechPadMs: o.speech_pad_ms }),
  });

  for (const testCase of fixture.cases) {
    it(`matches the reference: ${testCase.name}`, () => {
      const got = speechTimestamps(probs, fixture.audioLengthSamples, asOptions(testCase.options));
      expect(got).toEqual(testCase.expected);
    });
  }

  it('finds nothing in silence', () => {
    expect(speechTimestamps(new Float32Array(500), 500 * 512)).toEqual([]);
  });

  it('closes an open segment at the end of the audio', () => {
    const speech = new Float32Array(200).fill(0.9);
    const [only] = speechTimestamps(speech, 200 * 512, { speechPadMs: 0 });
    expect(only.end).toBe(200 * 512);
  });

  it('drops a burst shorter than the minimum', () => {
    const probs = new Float32Array(200);
    probs.fill(0.9, 10, 12); // 2 frames = 64 ms, under the 250 ms default
    expect(speechTimestamps(probs, 200 * 512)).toEqual([]);
  });

  it('converts to the seconds alignment metadata stores', () => {
    expect(toSeconds([{ start: 16000, end: 32000 }])).toEqual([{ timeBegin: 1, timeEnd: 2 }]);
    expect(SAMPLE_RATE).toBe(16000);
  });
});
