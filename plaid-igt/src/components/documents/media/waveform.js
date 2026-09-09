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

// Screens of timeline drawn either side of the one on show, so a scroll of
// less than a screen never waits for a redraw.
const WINDOW_MARGIN_SCREENS = 1;

// Buckets the decoded audio is reduced to, once, so every zoom and scroll
// redraws from these instead of decoding again. 500 a second is 2 ms per
// bucket, finer than the timeline is ever zoomed, and the cap keeps an
// hour-long recording to 4 MB.
const PEAK_BUCKETS_PER_SECOND = 500;
const MAX_PEAK_BUCKETS = 1_000_000;
// Bars are scaled against this percentile of the peaks rather than the single
// loudest sample, so one door slam does not flatten an hour of speech.
const PEAK_NORMALIZE_PERCENTILE = 0.99;

/**
 * The decoded audio reduced to one loudest-sample-per-bucket envelope, plus
 * the level the bars are drawn against.
 *
 * @returns {{peaks: Float32Array, level: number}}
 */
export const peaksOf = (channelData, duration) => {
  const buckets = Math.max(
    1,
    Math.min(MAX_PEAK_BUCKETS, Math.ceil((duration || 1) * PEAK_BUCKETS_PER_SECOND)),
  );
  const peaks = new Float32Array(buckets);
  const per = channelData.length / buckets;
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor(i * per);
    const end = Math.min(channelData.length, Math.max(start + 1, Math.floor((i + 1) * per)));
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const v = channelData[j] < 0 ? -channelData[j] : channelData[j];
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
  }
  const sorted = Float32Array.from(peaks).sort();
  const level =
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * PEAK_NORMALIZE_PERCENTILE))];
  return { peaks, level: level > 0 ? level : 1 };
};

/** The stretch of timeline to draw for a viewport, clamped to the timeline. */
export const windowFor = (scrollLeft, viewWidth, timelineWidth) => {
  const margin = viewWidth * WINDOW_MARGIN_SCREENS;
  const left = Math.max(0, Math.floor(scrollLeft - margin));
  const right = Math.min(timelineWidth, Math.ceil(scrollLeft + viewWidth + margin));
  return { left, width: Math.max(1, right - left) };
};

/** Is what is drawn still covering the viewport? */
export const covers = (drawn, scrollLeft, viewWidth) =>
  drawn.width > 0 && drawn.left <= scrollLeft && drawn.left + drawn.width >= scrollLeft + viewWidth;

/**
 * The bars for one window: each is `{x, y, width, height}` in the drawn
 * image's own pixels, centred on its middle. `left` and `width` are in the
 * TIMELINE's pixels, so the slice of the envelope is the slice of the
 * recording under that stretch, and a bar lands on the time it belongs to.
 */
export const barsFor = ({ peaks, level, left, width, timelineWidth, drawWidth }) => {
  if (!peaks?.length || !(timelineWidth > 0) || !(drawWidth > 0)) return [];
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
    const height = Math.max(MIN_BAR_HEIGHT, Math.min(1, peak / level) * WAVEFORM_AVAILABLE_HEIGHT);
    bars.push({
      x: (i / count) * drawWidth,
      y: TIMELINE_HEIGHT / 2 - height / 2,
      width: barWidth,
      height,
    });
  }
  return bars;
};
