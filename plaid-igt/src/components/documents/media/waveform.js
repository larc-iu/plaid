// The timeline's waveform, as arithmetic. Nothing here touches React or the
// DOM, so all of it is testable: the hook next door (useWaveform.js) decodes,
// draws and positions, and reads the shape of the picture from here.
//
// The one idea worth knowing: a canvas cannot be much wider than 16k pixels,
// so an image of the WHOLE timeline is capped and then stretched to fit. That
// cap is per RECORDING, not per zoom, which left a 30-minute one at ~100 ms of
// audio per bar however far in you zoomed — blocks, not speech, in exactly the
// view somebody drags a segment boundary in, while a short recording stayed
// sharp. So only the stretch on screen is drawn, and a window of a few
// thousand pixels is nowhere near the cap.

export const TIMELINE_HEIGHT = 100;
const WAVEFORM_AVAILABLE_HEIGHT = 90;
const MIN_BAR_HEIGHT = 2;

/** Browsers refuse a canvas much wider than this. */
export const MAX_CANVAS_WIDTH = 16384;

// Buckets the decoded audio is reduced to, once, so every zoom and scroll
// redraws from these instead of decoding again. 1000 a second is 1 ms per
// bucket, one bucket a pixel at the timeline's closest zoom (MAX_ZOOM), and
// the cap keeps an hour-long recording to 15 MB. Past the cap a bucket is
// a little longer than 1 ms.
const PEAK_BUCKETS_PER_SECOND = 1000;
const MAX_PEAK_BUCKETS = 4_000_000;
// Bars are scaled against this percentile of the peaks rather than the single
// loudest sample, so one door slam does not flatten an hour of speech.
const PEAK_NORMALIZE_PERCENTILE = 0.99;
// ...but never against less than this (about -46 dBFS). Scaling is what lets
// a quiet recording fill the picture; scaled against nothing, a recording
// with no sound in it fills the picture with its noise floor and looks like
// wall-to-wall speech. Below this there is nothing to show, so it stays flat.
const MIN_NORMALIZE_LEVEL = 0.005;

/**
 * The decoded audio reduced to one loudest-sample-per-bucket envelope, plus
 * the level the bars are drawn against.
 *
 * Every channel counts: a bucket's peak is the loudest sample on ANY of them.
 * A camera with an external microphone records it on one channel and leaves
 * the other all but silent, and a picture of the silent one, scaled up to
 * fill the timeline, is a picture of its noise floor. (The speech detector
 * mixes the channels down before it listens, which is why it was right about
 * that recording while the waveform was not.)
 *
 * @param {Float32Array[]} channels  one array of samples per channel
 * @returns {{peaks: Float32Array, level: number}}
 */
const bucketCount = (duration) =>
  Math.max(1, Math.min(MAX_PEAK_BUCKETS, Math.ceil((duration || 1) * PEAK_BUCKETS_PER_SECOND)));

// Buckets `from` to `to` of the envelope, written into `peaks`.
const fillPeaks = (peaks, channels, length, from, to) => {
  const per = length / peaks.length;
  for (let i = from; i < to; i += 1) {
    const start = Math.floor(i * per);
    const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * per)));
    let peak = 0;
    for (const channelData of channels) {
      for (let j = start; j < end && j < channelData.length; j += 1) {
        const v = channelData[j] < 0 ? -channelData[j] : channelData[j];
        if (v > peak) peak = v;
      }
    }
    peaks[i] = peak;
  }
};

// Peaks the level is read from: all of them for a short recording, an even
// sample of a long one. An hour's million were sorted whole, a tenth of a
// second with the page frozen, for a percentile a sample gives as well.
const LEVEL_SAMPLE = 50_000;
const levelOf = (peaks) => {
  const step = Math.max(1, Math.floor(peaks.length / LEVEL_SAMPLE));
  const sample = new Float32Array(Math.ceil(peaks.length / step));
  for (let i = 0, k = 0; i < peaks.length; i += step, k += 1) sample[k] = peaks[i];
  sample.sort();
  const level =
    sample[Math.min(sample.length - 1, Math.floor(sample.length * PEAK_NORMALIZE_PERCENTILE))];
  return Math.max(level, MIN_NORMALIZE_LEVEL);
};

export const peaksOf = (channels, duration) => {
  const peaks = new Float32Array(bucketCount(duration));
  const length = Math.max(0, ...channels.map((c) => c.length));
  fillPeaks(peaks, channels, length, 0, peaks.length);
  return { peaks, level: levelOf(peaks) };
};

// Buckets reduced between two looks at the page: about a hundredth of a
// second of work on a laptop.
const BUCKETS_PER_SLICE = 20_000;

/**
 * peaksOf, a slice at a time, handing the page back between slices. A long
 * recording is twenty million samples, and read in one go they froze the tab
 * for most of a second as it opened. Resolves to null, having stopped, once
 * `cancelled()` says the recording is no longer wanted.
 */
export const peaksOfInSlices = async (
  channels,
  duration,
  { pause = nextTask, cancelled = () => false } = {},
) => {
  const peaks = new Float32Array(bucketCount(duration));
  const length = Math.max(0, ...channels.map((c) => c.length));
  for (let from = 0; from < peaks.length; from += BUCKETS_PER_SLICE) {
    fillPeaks(peaks, channels, length, from, Math.min(peaks.length, from + BUCKETS_PER_SLICE));
    if (from + BUCKETS_PER_SLICE < peaks.length) {
      await pause();
      if (cancelled()) return null;
    }
  }
  return { peaks, level: levelOf(peaks) };
};

// The codings of a WAV read straight from its bytes: integer PCM of 8 to 32
// bits and 32-bit float, each turned into -1..1 as a decoder does. Null for
// any other, which is decoded.
const WAV_PCM = 0x0001;
const WAV_FLOAT = 0x0003;
const sampleOf = ({ tag, bitsPerSample }) => {
  if (tag === WAV_FLOAT && bitsPerSample === 32) return (v, at) => v.getFloat32(at, true);
  if (tag !== WAV_PCM) return null;
  if (bitsPerSample === 8) return (v, at) => (v.getUint8(at) - 128) / 128;
  if (bitsPerSample === 16) return (v, at) => v.getInt16(at, true) / 32768;
  if (bitsPerSample === 24)
    return (v, at) =>
      (v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16)) / 8388608;
  if (bitsPerSample === 32) return (v, at) => v.getInt32(at, true) / 2147483648;
  return null;
};

/**
 * The envelope of a PCM WAV read from its bytes, a slice at a time, with no
 * decoder: what peaksOfInSlices gives for the decoded samples, but holding
 * only one slice of the file at once. Decoding an hour at 48 kHz in stereo
 * took the whole file and every sample of it, about 3.7 GB.
 *
 * `read(from, to)` gives the file's bytes (a Promise of a Uint8Array) and
 * `info` is readWavInfo's. The envelope is of the channels averaged, as the
 * decoded mono is. `envelopes` is one per channel when `perChannel` is asked
 * for and there is more than one, else null. Null for a coding it cannot
 * read, or once `cancelled()` says the recording is no longer wanted.
 *
 * @returns {Promise<{envelope: {peaks: Float32Array, level: number},
 *   envelopes: Array<{peaks: Float32Array, level: number}>|null,
 *   channelCount: number}|null>}
 */
export const peaksOfPcmWav = async (
  read,
  info,
  duration,
  { perChannel = false, pause = nextTask, cancelled = () => false } = {},
) => {
  const sample = sampleOf(info);
  const { channels, blockAlign, dataOffset, dataSize } = info;
  const size = info.bitsPerSample / 8;
  if (!sample || dataOffset == null || !(channels > 0) || blockAlign !== channels * size) {
    return null;
  }
  const frames = Math.floor(dataSize / blockAlign);
  const mono = new Float32Array(bucketCount(duration));
  const lanes =
    perChannel && channels > 1
      ? Array.from({ length: channels }, () => new Float32Array(mono.length))
      : null;
  const per = frames / mono.length;
  for (let from = 0; from < mono.length; from += BUCKETS_PER_SLICE) {
    const to = Math.min(mono.length, from + BUCKETS_PER_SLICE);
    // The frames under buckets `from` to `to`, as fillPeaks takes them.
    const first = Math.floor(from * per);
    const last = Math.min(frames, Math.max(Math.floor((to - 1) * per) + 1, Math.floor(to * per)));
    const bytes = await read(dataOffset + first * blockAlign, dataOffset + last * blockAlign);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const have = first + Math.floor(bytes.byteLength / blockAlign);
    for (let i = from; i < to; i += 1) {
      const start = Math.floor(i * per);
      const end = Math.min(have, Math.max(start + 1, Math.floor((i + 1) * per)));
      let peak = 0;
      for (let f = start; f < end; f += 1) {
        const at = (f - first) * blockAlign;
        let sum = 0;
        for (let c = 0; c < channels; c += 1) {
          const v = sample(view, at + c * size);
          sum += v;
          if (lanes) {
            const a = v < 0 ? -v : v;
            if (a > lanes[c][i]) lanes[c][i] = a;
          }
        }
        const m = sum < 0 ? -sum / channels : sum / channels;
        if (m > peak) peak = m;
      }
      mono[i] = peak;
    }
    if (to < mono.length) {
      await pause();
      if (cancelled()) return null;
    }
  }
  return {
    envelope: { peaks: mono, level: levelOf(mono) },
    envelopes: lanes && lanes.map((peaks) => ({ peaks, level: levelOf(peaks) })),
    channelCount: channels,
  };
};

// The next task, through a message rather than a timer: a tab in the
// background runs a chain of zero timers once a second, which made a long
// recording's envelope take most of a minute there.
const nextTask = () =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

/**
 * The bars for one window: each is `{x, y, width, height}` in the drawn
 * image's own pixels, centred on its middle. `left` and `width` are in the
 * TIMELINE's pixels, so the slice of the envelope is the slice of the
 * recording under that stretch, and a bar lands on the time it belongs to.
 * `height` is the lane's, the whole track unless the track is split into a
 * lane per channel.
 */
export const barsFor = ({
  peaks,
  level,
  left,
  width,
  timelineWidth,
  drawWidth,
  height = TIMELINE_HEIGHT,
}) => {
  if (!peaks?.length || !(timelineWidth > 0) || !(drawWidth > 0)) return [];
  const available = (height * WAVEFORM_AVAILABLE_HEIGHT) / TIMELINE_HEIGHT;
  const from = (left / timelineWidth) * peaks.length;
  const to = ((left + width) / timelineWidth) * peaks.length;
  // Two bars per pixel, never finer than the envelope itself.
  const count = Math.max(1, Math.min(Math.ceil(to - from), Math.ceil(drawWidth * 2)));
  const per = (to - from) / count;
  const barWidth = Math.max(0.5, drawWidth / count);
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.max(0, Math.floor(from + i * per));
    const end = Math.min(peaks.length, Math.max(start + 1, Math.floor(from + (i + 1) * per)));
    let peak = 0;
    for (let j = start; j < end; j += 1) if (peaks[j] > peak) peak = peaks[j];
    const barHeight = Math.max(MIN_BAR_HEIGHT, Math.min(1, peak / level) * available);
    bars.push({
      x: (i / count) * drawWidth,
      y: height / 2 - barHeight / 2,
      width: barWidth,
      height: barHeight,
    });
  }
  return bars;
};
