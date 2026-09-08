// How long a recording is, without decoding it.
//
// Two ways, because neither covers everything.
//
// An MP4/M4A/MOV says so in its `mvhd` box, and the box chain can be WALKED
// rather than read: each box header gives its own size, so skipping a
// 250 MB `mdat` costs one 16-byte read. This matters because ffmpeg writes
// `moov` at the END by default, and a <video preload="metadata"> handed such a
// file simply never fires loadedmetadata — the case that sent this looking.
//
// Everything else (WAV, MP3, WebM, Ogg) goes to a media element, which reads
// the header and stops. Anything that fails both is unknown, and a caller has
// to manage without: this only decides whether a size can be promised before a
// conversion, never whether one can happen.

const ELEMENT_TIMEOUT_MS = 4000;
const HEADER = 16;

const readSlice = async (file, from, to) =>
  new DataView(await file.slice(from, Math.min(to, file.size)).arrayBuffer());

const typeAt = (view, at) =>
  String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );

/**
 * Walk the top-level box chain to `moov`, then its children to `mvhd`, and
 * read the duration off it. Null when the file is not this shape.
 */
async function mp4Duration(file) {
  const walk = async (from, end, wanted) => {
    let at = from;
    while (at + 8 <= end) {
      const head = await readSlice(file, at, at + HEADER);
      if (head.byteLength < 8) return null;
      let size = head.getUint32(0);
      const type = typeAt(head, 4);
      let body = at + 8;
      if (size === 1) {
        if (head.byteLength < 16) return null;
        // 64-bit sizes past 2^53 cannot be a real file; the high word is 0.
        size = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
        body = at + 16;
      } else if (size === 0) {
        size = end - at; // extends to the end of the file
      }
      if (size < 8) return null;
      if (type === wanted) return { body, end: at + size };
      at += size;
    }
    return null;
  };

  const moov = await walk(0, file.size, 'moov');
  if (!moov) return null;
  const mvhd = await walk(moov.body, moov.end, 'mvhd');
  if (!mvhd) return null;

  const box = await readSlice(file, mvhd.body, mvhd.body + 32);
  if (box.byteLength < 20) return null;
  const version = box.getUint8(0);
  // version 0: creation(4) modified(4) timescale(4) duration(4)
  // version 1: creation(8) modified(8) timescale(4) duration(8)
  const timescale = version === 1 ? box.getUint32(20) : box.getUint32(12);
  const duration =
    version === 1 ? box.getUint32(24) * 2 ** 32 + box.getUint32(28) : box.getUint32(16);
  if (!timescale || !duration || duration === 0xffffffff) return null;
  return duration / timescale;
}

/** Ask the browser's own media pipeline, which reads the header and stops. */
function elementDuration(file) {
  return new Promise((resolve) => {
    let url = null;
    let el = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (el) {
        el.removeAttribute('src');
        el.load?.();
      }
      if (url) URL.revokeObjectURL(url);
      resolve(value);
    };
    try {
      url = URL.createObjectURL(file);
      // A <video> reads audio-only files too, so one element covers both.
      el = document.createElement('video');
      el.preload = 'metadata';
      el.muted = true;
      el.addEventListener('loadedmetadata', () =>
        finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null),
      );
      el.addEventListener('error', () => finish(null));
      el.src = url;
      setTimeout(() => finish(null), ELEMENT_TIMEOUT_MS);
    } catch {
      finish(null);
    }
  });
}

/** Duration in seconds, or null when neither way can say. */
export async function readDuration(file) {
  try {
    const fromBoxes = await mp4Duration(file);
    if (fromBoxes) return fromBoxes;
  } catch {
    // A truncated or unusual file: fall through to the media element.
  }
  return elementDuration(file);
}

export const __test = { mp4Duration };
