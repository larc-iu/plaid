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

/**
 * The zip's record of each document's exact name, by its entry. An entry's
 * name is made safe for a file system, so two names can share one spelling
 * there, and the import names each document from this record instead.
 */
export const NAMES_FILE = 'plaid-documents.json';

/** The record's text for `entries`, `[{ path, name }]`. */
export const namesRecord = (entries) =>
  `${JSON.stringify({ documents: entries.map(({ path, name }) => ({ file: path, name })) }, null, 2)}\n`;

const lastPart = (path) => String(path).split('/').pop();

/**
 * The record's names by entry file name (without any folder), or an empty map
 * for text that is no record.
 */
export const readNamesRecord = (text) => {
  const names = new Map();
  try {
    const documents = JSON.parse(text)?.documents;
    if (!Array.isArray(documents)) return names;
    for (const d of documents) {
      if (typeof d?.file === 'string' && typeof d?.name === 'string' && d.name.trim()) {
        names.set(lastPart(d.file), d.name);
      }
    }
  } catch {
    // Not a record: every file is named after itself.
  }
  return names;
};

/** Whether `path` names the record, in a folder or not. */
export const isNamesRecord = (path) => lastPart(path) === NAMES_FILE;

/** An entry's file name without its folders. */
export const entryFileName = lastPart;
