// Filenames, browser downloads, and zip assembly for exports.

import { zip } from 'fflate';
import { readAll } from '../domain/documentReads.js';

/** A safe cross-platform filename (without extension handling). */
export function sanitizeFilename(name) {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  // Cap by code points so the cut can't strand half a surrogate pair.
  const capped = [...cleaned].slice(0, 120).join('').trim();
  return capped === '' ? 'untitled' : capped;
}

/**
 * Dedupe by inserting " (2)", " (3)", … before the extension. Suffixed names
 * are checked against everything produced so far — a generated "a (2).txt"
 * must not collide with a literal "a (2).txt" later in the list (zip entries
 * are keyed by path, so a collision silently drops a file).
 */
export function dedupeFilenames(names) {
  const used = new Set();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) candidate = `${stem} (${n})${ext}`;
    used.add(candidate);
    return candidate;
  });
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Files compressed at once while a zip is assembled. fflate's `zip` deflates
// every file of 160 KB or more in a worker of its own, all of them at once: a
// project export of 400 documents started 400 workers and took 5 to 7 GB,
// which crashes a tab. So each file is zipped alone, this many at a time,
// and the one-file archives are joined.
const FILES_AT_ONCE = 4;

// One file as a one-file archive: its local header and data, its central
// directory record, and the 22-byte end record (no comment, no zip64).
function zipOne({ path, data, opts }) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Promise((resolve, reject) => {
    zip({ [path]: opts ? [bytes, opts] : bytes }, { level: 6 }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
}

const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const putU16 = (b, at, v) => {
  b[at] = v & 0xff;
  b[at + 1] = (v >>> 8) & 0xff;
};
const putU32 = (b, at, v) => {
  putU16(b, at, v & 0xffff);
  putU16(b, at + 2, v >>> 16);
};

// One-file archives joined into one, byte for byte the archive fflate writes
// for all the files together: every local section in order, then every
// central record with its local header's offset moved to where it now sits,
// then the end record.
function joinZips(parts) {
  const locals = [];
  const centrals = [];
  let localSize = 0;
  let centralSize = 0;
  for (const part of parts) {
    const end = part.length - 22;
    if (u32(part, end) !== 0x06054b50) throw new Error('Not a one-file zip');
    const size = u32(part, end + 12);
    const at = u32(part, end + 16);
    const central = part.slice(at, at + size);
    putU32(central, 42, localSize);
    locals.push(part.subarray(0, at));
    centrals.push(central);
    localSize += at;
    centralSize += size;
  }
  const out = new Uint8Array(localSize + centralSize + 22);
  let o = 0;
  for (const chunk of [...locals, ...centrals]) {
    out.set(chunk, o);
    o += chunk.length;
  }
  putU32(out, o, 0x06054b50);
  putU16(out, o + 8, parts.length);
  putU16(out, o + 10, parts.length);
  putU32(out, o + 12, centralSize);
  putU32(out, o + 16, localSize);
  return out;
}

/**
 * files: [{ path, data: string | Uint8Array, opts? }] → zip Blob, the entries
 * in the order given. Per-entry `opts` override the default compression —
 * media entries pass { level: 0 } since audio/video is already compressed.
 * Paths are unique (dedupeFilenames).
 */
export async function assembleZip(files) {
  const parts = await readAll(files, zipOne, { inFlight: FILES_AT_ONCE });
  return new Blob([joinZips(parts)], { type: 'application/zip' });
}
