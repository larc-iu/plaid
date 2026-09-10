import { useEffect, useRef, useState } from 'react';
import { notifyWarning } from '@/utils/feedback';
import {
  MAX_CANVAS_WIDTH,
  TIMELINE_HEIGHT,
  barsFor,
  covers,
  peaksOf,
  windowFor,
} from './waveform.js';

// Drawing the timeline's waveform: decode once, redraw the stretch on screen.
//
// Two costs, kept apart. DECODING is slow and does not depend on the view, so
// it happens once per recording and produces an amplitude envelope; every zoom
// and scroll is drawn from that, in a millisecond or two. See waveform.js for
// why only a window is drawn.
//
// There used to be a localStorage cache of the finished PNG, keyed by a hash
// over the recording's bytes and the full timeline width. It cannot survive
// windowed drawing (there is no one image any more), and it was reading the
// whole recording just to look in the cache. What it actually bought — not
// decoding again on the way back to a document — is the envelope cache below.

// Envelopes for the last few recordings looked at. Keyed by byte length and
// duration, because the tab refetches the recording and gets a fresh Blob.
const ENVELOPE_CACHE_LIMIT = 3;
const envelopeCache = new Map();
const envelopeKey = (blob, duration) => `${blob?.size ?? 0}_${Math.round(duration * 1000)}`;
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

const canvasFor = (width) => {
  const pixelRatio = window.devicePixelRatio || 1;
  const canvas = window.document.createElement('canvas');
  canvas.width = Math.min(Math.max(1, Math.round(width * pixelRatio)), MAX_CANVAS_WIDTH);
  canvas.height = TIMELINE_HEIGHT * pixelRatio;
  const ctx = canvas.getContext('2d');
  ctx.scale(pixelRatio, pixelRatio);
  return { canvas, ctx, drawWidth: canvas.width / pixelRatio };
};

/**
 * @param {Blob|null} mediaBlob    the recording, already fetched for playback
 * @param {number} duration        seconds
 * @param {number} timelineWidth   the timeline's full width in its own pixels
 * @param {number} scrollLeft      how far along it is scrolled
 * @param {{current: HTMLElement|null}} containerRef  the scrolling box
 * @returns {{image: string|null, box: {left: number, width: number}, loading: boolean}}
 */
export function useWaveform({ mediaBlob, duration, timelineWidth, scrollLeft, containerRef }) {
  const [image, setImage] = useState(null);
  const [box, setBox] = useState({ left: 0, width: 0 });
  const [loading, setLoading] = useState(false);
  // The envelope in hand, what the image on screen was drawn from, and a
  // decode already running that a second draw can join rather than repeat: a
  // decode of an hour-long recording is hundreds of megabytes of PCM.
  const envelopeRef = useRef({ blob: null, peaks: null, level: 1 });
  const drawnRef = useRef({ blob: null, timelineWidth: 0, left: 0, width: 0 });
  const decodeRef = useRef(null);

  // Object URLs are revoked as they are replaced, and on the way out.
  useEffect(() => {
    return () => {
      if (image && image.startsWith('blob:')) URL.revokeObjectURL(image);
    };
  }, [image]);

  useEffect(() => {
    let cancelled = false;
    let retry = null;
    const draw = async () => {
      if (!mediaBlob || !duration || timelineWidth < 100) return;
      const view = containerRef.current?.clientWidth || 0;
      // The window is measured off the scrolling box, so there is nothing to
      // draw until it has a width. Nothing else would fire the effect again
      // once it does, so ask for the next frame rather than give up.
      if (!view) {
        retry = requestAnimationFrame(draw);
        return;
      }
      const drawn = drawnRef.current;
      if (
        drawn.blob === mediaBlob &&
        drawn.timelineWidth === timelineWidth &&
        covers(drawn, scrollLeft, view)
      ) {
        return;
      }
      const at = windowFor(scrollLeft, view, timelineWidth);
      setLoading(true);
      try {
        if (envelopeRef.current.blob !== mediaBlob) {
          const key = envelopeKey(mediaBlob, duration);
          const cached = envelopeCache.get(key);
          if (cached) {
            envelopeRef.current = { blob: mediaBlob, ...cached };
          } else {
            if (decodeRef.current?.blob !== mediaBlob) {
              decodeRef.current = {
                blob: mediaBlob,
                promise: (async () => {
                  const audio = new (window.AudioContext || window.webkitAudioContext)();
                  // The bytes are already in memory as the blob behind the
                  // player's <video> src, so there is nothing to fetch.
                  // decodeAudioData detaches the buffer, hence the fresh copy.
                  const decoded = await audio.decodeAudioData(await mediaBlob.arrayBuffer());
                  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
                    decoded.getChannelData(i),
                  );
                  return rememberEnvelope(key, peaksOf(channels, duration));
                })(),
              };
            }
            envelopeRef.current = { blob: mediaBlob, ...(await decodeRef.current.promise) };
          }
        }
        if (cancelled) return;
        const { peaks, level } = envelopeRef.current;
        const { canvas, ctx, drawWidth } = canvasFor(at.width);
        ctx.fillStyle = themeColor('--primary', 0.35);
        for (const bar of barsFor({ peaks, level, ...at, timelineWidth, drawWidth })) {
          ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
        }
        publish(canvas, at);
      } catch (error) {
        console.error('Failed to generate waveform:', error);
        notifyWarning(
          'The audio waveform could not be generated, so the timeline shows a flat placeholder. Playback and time alignment still work.',
          'Waveform unavailable',
        );
        // No amplitudes, so a flat centreline rather than randomised bars,
        // which would read as a genuine signal.
        const { canvas, ctx, drawWidth } = canvasFor(at.width);
        ctx.fillStyle = themeColor('--primary', 0.3);
        ctx.fillRect(0, TIMELINE_HEIGHT / 2, drawWidth, 1);
        publish(canvas, at);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const publish = (canvas, at) => {
      drawnRef.current = { blob: mediaBlob, timelineWidth, left: at.left, width: at.width };
      canvas.toBlob((blob) => {
        if (!blob || cancelled) return;
        setBox({ left: at.left, width: at.width });
        setImage(URL.createObjectURL(blob));
      });
    };

    draw();
    return () => {
      cancelled = true;
      if (retry) cancelAnimationFrame(retry);
    };
  }, [mediaBlob, duration, timelineWidth, scrollLeft, containerRef]);

  return { image, box, loading };
}
