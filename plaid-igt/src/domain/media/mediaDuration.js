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
// A WAV says so in its `fmt ` and `data` chunks, which is worth reading for the
// same reason: an hour of uncompressed audio is hundreds of megabytes, exactly
// the file that needs converting, and Chrome will not report metadata for one
// of those either.
//
// Everything else (MP3, WebM, Ogg) goes to a media element, which reads the
// header and stops. Anything that fails all three is unknown, and a caller has
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

/**
 * RIFF/WAVE: walk the chunks to `fmt ` for the byte rate and `data` for the
 * length in bytes. Null when the file is not this shape.
 */
async function wavDuration(file) {
  const head = await readSlice(file, 0, 12);
  if (head.byteLength < 12) return null;
  if (typeAt(head, 0) !== 'RIFF' || typeAt(head, 8) !== 'WAVE') return null;

  let at = 12;
  let byteRate = 0;
  while (at + 8 <= file.size) {
    const chunk = await readSlice(file, at, at + 8);
    if (chunk.byteLength < 8) return null;
    const id = typeAt(chunk, 0);
    const size = chunk.getUint32(4, true); // RIFF is little-endian
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      const fmt = await readSlice(file, body, body + 16);
      byteRate = fmt.getUint32(8, true);
    } else if (id === 'data') {
      if (!byteRate) return null;
      // A streamed WAV can declare size 0 and run to the end of the file.
      const bytes = size > 0 ? size : file.size - body;
      return bytes / byteRate;
    }
    // Chunks are padded to an even length.
    at = body + size + (size % 2);
  }
  return null;
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
      // An <audio> for audio: a <video> handed a large audio-only file reports
      // no metadata at all, which is how the WAV reader above came to exist.
      el = document.createElement(file.type?.startsWith('video/') ? 'video' : 'audio');
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
  for (const read of [mp4Duration, wavDuration]) {
    try {
      const seconds = await read(file);
      if (seconds) return seconds;
    } catch {
      // A truncated or unusual file: try the next way of asking.
    }
  }
  return elementDuration(file);
}

export const __test = { mp4Duration, wavDuration };
