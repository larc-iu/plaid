// Getting a recording into the one shape the model accepts: mono, 16 kHz,
// float samples in [-1, 1].
//
// `decodeAudioData` resamples to the context's rate, so asking a 16 kHz
// OfflineAudioContext to decode does the work in the browser's own resampler
// rather than a hand-rolled one. Not every browser honours the context rate,
// hence the render fallback below.
//
// Size matters here. An hour of 16 kHz mono is 230 MB of Float32, about a
// fifth of an hour decoded at 44.1 kHz in stereo. The channels are kept apart
// only when asked for (`perChannel`): a recording with a speaker on each
// channel is listened to channel by channel, and the rest of the time the
// average is all anything needs.

const OfflineCtx = () =>
  typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);

export const TARGET_RATE = 16000;

const channelsOf = (buffer) =>
  Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));

const mixToMono = (channels) => {
  if (channels.length === 1) return channels[0];
  const mono = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i];
  }
  for (let i = 0; i < mono.length; i++) mono[i] /= channels.length;
  return mono;
};

/** `samples` at `fromRate` rendered at `toRate`, through the browser's resampler. */
export const resampleMono = async (samples, fromRate, toRate) => {
  if (fromRate === toRate) return samples;
  const Ctx = OfflineCtx();
  const length = Math.max(1, Math.ceil((samples.length * toRate) / fromRate));
  const context = new Ctx(1, length, toRate);
  const source = context.createBufferSource();
  const buffer = context.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
};

/**
 * Decode `blob` at 16 kHz: `{ mono, channels, channelCount }`, where
 * `channels` is one Float32Array per channel when `perChannel` is asked for
 * and null otherwise. Throws with the browser's own message when the file is
 * not decodable audio (a video container without an audio track, say).
 */
export async function decodeTo16k(blob, { perChannel = false } = {}) {
  const Ctx = OfflineCtx();
  if (!Ctx) throw new Error('This browser has no OfflineAudioContext.');
  // `arrayBuffer()` hands back a fresh copy each call, and decodeAudioData
  // detaches what it is given, so this never disturbs another decode of the
  // same blob.
  const bytes = await blob.arrayBuffer();
  const decoded = await new Ctx(1, 1, TARGET_RATE).decodeAudioData(bytes);
  const at16k = async (samples) =>
    decoded.sampleRate === TARGET_RATE
      ? samples
      : resampleMono(samples, decoded.sampleRate, TARGET_RATE);
  const channels = channelsOf(decoded);
  const mono = await at16k(mixToMono(channels));
  const kept = perChannel && channels.length > 1 ? await Promise.all(channels.map(at16k)) : null;
  return { mono, channels: kept, channelCount: channels.length };
}

/** Decode `blob` to a mono Float32Array at 16 kHz. */
export async function decodeTo16kMono(blob) {
  return (await decodeTo16k(blob)).mono;
}
