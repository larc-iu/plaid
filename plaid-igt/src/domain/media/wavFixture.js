import { emptyWav, writeChannel } from './mixdown.js';

/**
 * For tests: a 16-bit PCM WAV of `channels` (one Float32Array per channel,
 * -1..1, all the same length), made the way a mix is made. The app itself
 * writes a mix one file at a time (mixRecordings.js) and never holds every
 * channel at once.
 */
export function encodeWav(channels, sampleRate) {
  const bytes = emptyWav(channels.length, channels[0]?.length ?? 0, sampleRate);
  for (const [c, samples] of channels.entries()) writeChannel(bytes, c, [samples]);
  return bytes;
}
