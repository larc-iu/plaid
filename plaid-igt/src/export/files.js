// Filenames, browser downloads, and zip assembly for exports.

import { zip } from 'fflate';

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

/** files: [{ path, data: string | Uint8Array }] → zip Blob (async fflate). */
export function assembleZip(files) {
  const encoder = new TextEncoder();
  const entries = {};
  for (const f of files) {
    entries[f.path] = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
  }
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (err, data) => {
      if (err) reject(err);
      else resolve(new Blob([data], { type: 'application/zip' }));
    });
  });
}
