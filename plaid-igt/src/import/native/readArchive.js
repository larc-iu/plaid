// Read + validate a Plaid IGT JSON archive (the native export format,
// docs/native-format.md). Pure: bytes in, parsed structures out.

import { unzipSync } from 'fflate';
import { decodeText, NotUtf8FileError } from '@ui/lib/textFile.js';

export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveError';
  }
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
    throw new ArchiveError('Not a Plaid IGT archive. The project.json file is missing');
  }
  const json = (path) => {
    if (!entries[path]) throw new ArchiveError(`Archive entry missing: ${path}`);
    let text;
    try {
      text = decodeText(entries[path]);
    } catch (e) {
      if (e instanceof NotUtf8FileError) throw new ArchiveError(`${path} is not UTF-8.`);
      throw e;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new ArchiveError(`${path} is not valid JSON: ${e.message}`);
    }
  };

  const manifest = json('project.json');
  if (manifest.format !== 'plaid-igt') {
    throw new ArchiveError(
      `Unrecognized format ${JSON.stringify(manifest.format)}. Expected "plaid-igt"`,
    );
  }
  // Per the spec's versioning policy, additive changes don't bump the version,
  // so only a different MAJOR (integer) version is unreadable.
  if (manifest.formatVersion !== 1) {
    throw new ArchiveError(
      `Unsupported formatVersion ${manifest.formatVersion}. This build reads version 1`,
    );
  }

  // An import finds each vocabulary's place in the new project by its name,
  // so two sharing one would merge. The person gives them different names
  // (ruled a user error, 2026-09-17).
  const vocabNames = new Set();
  for (const row of manifest.vocabularies || []) {
    if (vocabNames.has(row.name)) {
      throw new ArchiveError(
        `Two vocabularies are named "${row.name}". Rename one in the project and export again.`,
      );
    }
    vocabNames.add(row.name);
  }

  const vocabularies = (manifest.vocabularies || []).map((row) => ({
    ...row,
    data: json(row.file),
  }));
  const documents = (manifest.documents || []).map((row) => ({
    ...row,
    data: json(row.file),
    mediaBytes: row.mediaFile ? (entries[row.mediaFile] ?? null) : null,
  }));
  // A resume finds what an earlier run made by each document's id, so an id
  // missing or repeated would have it take one document for another. It marks
  // a document with the id as a string, so ids are compared as strings.
  const docIds = new Set();
  for (const doc of documents) {
    const id = doc.data?.id;
    if (id == null || id === '') {
      throw new ArchiveError(`The document in ${doc.file} has no id.`);
    }
    if (docIds.has(String(id))) {
      throw new ArchiveError(
        `Two documents in the archive have the id ${JSON.stringify(String(id))}.`,
      );
    }
    docIds.add(String(id));
  }
  return { manifest, vocabularies, documents };
}
