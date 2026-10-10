// File names for a project's import and export: what a file's document is
// called, and what a document's file is called inside the zip.

import { sanitizeFilename } from '../../lib/download.js';

/** A file's name without its format's extension (or `.txt`): the document's name. */
export const baseFileName = (name, extension) => {
  const ext = extension.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name.replace(new RegExp(`\\.(${ext}|txt)$`, 'i'), '') || name;
};

/**
 * A zip entry for a document. Document names are not unique, so the second
 * `name.ext` becomes `name (2).ext`, and so on. `used` is the set of entries
 * taken so far, and the one returned is added to it.
 */
export const dedupeFileName = (name, extension, used) => {
  const base = sanitizeFilename(name);
  let candidate = `${base}${extension}`;
  let n = 2;
  while (used.has(candidate)) candidate = `${base} (${n++})${extension}`;
  used.add(candidate);
  return candidate;
};
