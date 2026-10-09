import { useEffect, useRef, useState } from 'react';
import { notifyWarning } from '@/utils/feedback';
import { decodeShared } from '../../../domain/vad/sharedDecode.js';
import { MAX_CANVAS_WIDTH, TIMELINE_HEIGHT, barsFor, peaksOfInSlices } from './waveform.js';

// Drawing the timeline's waveform: decode once, redraw the stretch on screen.
//
// Two costs, kept apart. DECODING is slow and does not depend on the view, so
// it happens once per recording and produces an amplitude envelope; every zoom
// and scroll is drawn from that, in a millisecond or two, straight onto a
// canvas on the timeline. (It used to be drawn off screen and encoded to a PNG
// for a CSS background, which cost more than the drawing and arrived a beat
// after the zoom it was for.) See waveform.js for why only a window is drawn.
//
// There used to be a localStorage cache of the finished PNG, keyed by a hash
// over the recording's bytes and the full timeline width. It cannot survive
// windowed drawing (there is no one image any more), and it was reading the
// whole recording just to look in the cache. What it actually bought — not
// decoding again on the way back to a document — is the envelope cache below.

// Envelopes for the last few recordings looked at. Keyed by the recording's
// versioned URL (the document's `mediaUrl`, whose `?v=` changes when the file
// is replaced), because the tab refetches the recording and gets a fresh Blob.
// Byte length and duration are no identity: two takes of one length are
// routine, and one drew the other's picture.
const ENVELOPE_CACHE_LIMIT = 3;
const envelopeCache = new Map();
const rememberEnvelope = (key, value) => {
  envelopeCache.delete(key);
  envelopeCache.set(key, value);
  while (envelopeCache.size > ENVELOPE_CACHE_LIMIT) {
    envelopeCache.delete(envelopeCache.keys().next().value);
  }
  return value;
};

// A theme colour for the canvas, which cannot read CSS variables itself. The
// shadcn variables hold bare HSL components ("221.2 83.2% 53.3%").
const themeColor = (name, alpha) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const [h, s, l] = raw.split(/\s+/);
  return h && s && l ? `hsla(${h}, ${s}, ${l}, ${alpha})` : `rgba(144, 202, 249, ${alpha})`;
};

// The samples the envelope is drawn from: the recording as mono 16 kHz, the
// decode speech detection makes, and the same one when both run at once
// (sharedDecode.js). Not the device rate, which ran out of memory on a long
// recording (110 minutes of a 16 kHz MP3 at 44.1 kHz is 291 million samples),
// and not lower: 8 kHz drops everything above 4 kHz, where [s] and [f] are,
// and drew them as silence. Mono is the channels mixed, so a recording with
// the voice on one channel still draws it.
const decodeForEnvelope = async (blob) => [(await decodeShared(blob)).samples];

/**
 * The recording's amplitude envelope, decoded once per recording.
 *
 * @param {Blob|null} mediaBlob    the recording, already fetched
 * @param {string|null} mediaKey   names that recording and its version (the
 *                                 document's `mediaUrl`)
 * @param {number} duration        seconds
 * @returns {{envelope: {peaks: Float32Array, level: number}|null|'failed', loading: boolean}}
 *   `'failed'` when the recording could not be decoded, which draws a flat line.
 */
export function useWaveform({ mediaBlob, mediaKey, duration }) {
  const [state, setState] = useState({ blob: null, envelope: null });
  // The recording whose decode failed and was said so, so a second look at it
  // draws the flat line again without a second notice.
  const failedRef = useRef(null);

  useEffect(() => {
    if (!mediaBlob || !duration) return undefined;
    let cancelled = false;
    const key = mediaKey || null;
    const cached = key ? envelopeCache.get(key) : null;
    if (cached) {
      setState({ blob: mediaBlob, envelope: cached });
      return undefined;
    }
    (async () => {
      try {
        const envelope = await peaksOfInSlices(await decodeForEnvelope(mediaBlob), duration);
        // A decode the recording has moved on from is kept nowhere.
        if (cancelled) return;
        if (key) rememberEnvelope(key, envelope);
        setState({ blob: mediaBlob, envelope });
      } catch (error) {
        if (failedRef.current !== mediaBlob) {
          failedRef.current = mediaBlob;
          console.error('Failed to generate waveform:', error);
          notifyWarning('The timeline shows a flat line.', 'Waveform unavailable');
        }
        if (!cancelled) setState({ blob: mediaBlob, envelope: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaBlob, mediaKey, duration]);

  const current = state.blob === mediaBlob ? state.envelope : null;
  return { envelope: current, loading: !!mediaBlob && !!duration && !current };
}

/**
 * Draw the envelope for the stretch `from`..`to` seconds into `canvas`, at the
 * zoom `pixelsPerSecond`, sized for the screen it is on. Synchronous and a few
 * milliseconds: there is no image to encode, the canvas is the picture.
 */
export function drawWaveform(canvas, envelope, { from, to, duration, pixelsPerSecond }) {
  if (!canvas || !(duration > 0) || !(to > from)) return;
  const pixelRatio = window.devicePixelRatio || 1;
  const width = (to - from) * pixelsPerSecond;
  canvas.width = Math.min(Math.max(1, Math.round(width * pixelRatio)), MAX_CANVAS_WIDTH);
  canvas.height = TIMELINE_HEIGHT * pixelRatio;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(canvas.width / width, pixelRatio);
  if (envelope === 'failed') {
    // No amplitudes, so a flat centreline rather than randomised bars, which
    // would read as a genuine signal.
    ctx.fillStyle = themeColor('--primary', 0.3);
    ctx.fillRect(0, TIMELINE_HEIGHT / 2, width, 1);
    return;
  }
  const timelineWidth = duration * pixelsPerSecond;
  ctx.fillStyle = themeColor('--primary', 0.35);
  for (const bar of barsFor({
    peaks: envelope.peaks,
    level: envelope.level,
    left: from * pixelsPerSecond,
    width,
    timelineWidth,
    drawWidth: width,
  })) {
    ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
  }
}
