// Filenames, browser downloads, and zip assembly for exports.

import { zip } from 'fflate';

/** A safe cross-platform filename (without extension handling). */
export function sanitizeFilename(name) {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120)
    .trim();
  return cleaned === '' ? 'untitled' : cleaned;
}

/** Dedupe by inserting " (2)", " (3)", … before the extension. */
export function dedupeFilenames(names) {
  const counts = new Map();
  return names.map((name) => {
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
      : `${name} (${n})`;
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
