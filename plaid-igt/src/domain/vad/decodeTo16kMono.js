// Getting a recording into the one shape the model accepts: mono, 16 kHz,
// float samples in [-1, 1].
//
// `decodeAudioData` resamples to the context's rate, so asking a 16 kHz
// OfflineAudioContext to decode does the work in the browser's own resampler
// rather than a hand-rolled one. Not every browser honours the context rate,
// hence the render fallback below.
//
// Size matters here. An hour of 16 kHz mono is 230 MB of Float32, which is
// still four times smaller than the full-rate stereo decode the waveform
// already does on the same file, so this is not the tab's memory ceiling.

const OfflineCtx = () =>
  typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);

export const TARGET_RATE = 16000;

const mixToMono = (buffer) => {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i];
  }
  for (let i = 0; i < mono.length; i++) mono[i] /= buffer.numberOfChannels;
  return mono;
};

const resample = async (mono, fromRate) => {
  const Ctx = OfflineCtx();
  const length = Math.max(1, Math.ceil((mono.length * TARGET_RATE) / fromRate));
  const context = new Ctx(1, length, TARGET_RATE);
  const source = context.createBufferSource();
  const buffer = context.createBuffer(1, mono.length, fromRate);
  buffer.copyToChannel(mono, 0);
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
};

/**
 * Decode `blob` to a mono Float32Array at 16 kHz. Throws with the browser's
 * own message when the file is not decodable audio (a video container without
 * an audio track, say).
 */
export async function decodeTo16kMono(blob) {
  const Ctx = OfflineCtx();
  if (!Ctx) throw new Error('This browser has no OfflineAudioContext.');
  // `arrayBuffer()` hands back a fresh copy each call, and decodeAudioData
  // detaches what it is given, so this never disturbs the waveform's decode of
  // the same blob.
  const bytes = await blob.arrayBuffer();
  const decoded = await new Ctx(1, 1, TARGET_RATE).decodeAudioData(bytes);
  const mono = mixToMono(decoded);
  return decoded.sampleRate === TARGET_RATE ? mono : resample(mono, decoded.sampleRate);
}
