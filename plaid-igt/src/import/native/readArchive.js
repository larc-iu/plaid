// Read + validate a Plaid IGT JSON archive (the native export format,
// docs/native-format.md). Pure: bytes in, parsed structures out.

import { unzipSync } from 'fflate';

export class ArchiveError extends Error {
  constructor(message) { super(message); this.name = 'ArchiveError'; }
}

/**
 * @param {Uint8Array} bytes - the .zip archive
 * @returns {{ manifest, vocabularies: [{id, name, file, data}],
 *             documents: [{id, name, file, mediaFile, data, mediaBytes}] }}
 */
export function readNativeArchive(bytes) {
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ArchiveError('Not a zip archive');
  }
  if (!entries['project.json']) {
    throw new ArchiveError('Not a Plaid IGT archive — project.json is missing');
  }
  const json = (path) => {
    if (!entries[path]) throw new ArchiveError(`Archive entry missing: ${path}`);
    try {
      return JSON.parse(new TextDecoder().decode(entries[path]));
    } catch (e) {
      throw new ArchiveError(`${path} is not valid JSON: ${e.message}`);
    }
  };

  const manifest = json('project.json');
  if (manifest.format !== 'plaid-igt') {
    throw new ArchiveError(`Unrecognized format ${JSON.stringify(manifest.format)} — expected "plaid-igt"`);
  }
  // Per the spec's versioning policy, additive changes don't bump the version,
  // so only a different MAJOR (integer) version is unreadable.
  if (manifest.formatVersion !== 1) {
    throw new ArchiveError(`Unsupported formatVersion ${manifest.formatVersion} — this build reads version 1`);
  }

  const vocabularies = (manifest.vocabularies || []).map((row) => ({ ...row, data: json(row.file) }));
  const documents = (manifest.documents || []).map((row) => ({
    ...row,
    data: json(row.file),
    mediaBytes: row.mediaFile ? entries[row.mediaFile] ?? null : null,
  }));
  return { manifest, vocabularies, documents };
}
