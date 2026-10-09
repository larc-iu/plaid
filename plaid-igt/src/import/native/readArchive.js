// Read + validate a Plaid IGT JSON archive (the native export format,
// docs/native-format.md). Pure: bytes in, parsed structures out.

import { unzipSync } from 'fflate';
import { composeText } from '@larc-iu/plaid-client';
import { decodeText, NotUtf8FileError } from '@ui/lib/textFile.js';

export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveError';
  }
}

// `v` with every string in it composed (NFC), as the server stores text, and,
// with `at`, every `begin` and `end` (an offset into the document's
// baseline.body, all `n` code points of it) moved as composing the body moves
// it. An archive written from text stored decomposed then imports onto the
// text as stored, its tokens over the same letters.
const composed = (v, at = null, n = 0) => {
  if (typeof v === 'string') return v.normalize('NFC');
  if (Array.isArray(v)) return v.map((x) => composed(x, at, n));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const offset = at && (k === 'begin' || k === 'end') && Number.isInteger(x) && x >= 0 && x <= n;
    out[k.normalize('NFC')] = offset ? at(x) : composed(x, at, n);
  }
  return out;
};

const composedDocument = (data) => {
  const body = data?.baseline?.body;
  if (typeof body !== 'string') return composed(data);
  const { at } = composeText(body);
  return composed(data, at, [...body].length);
};

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

  // The archive's own file names are looked up as written (`raw`), and
  // everything else is read composed.
  const raw = json('project.json');
  const manifest = composed(raw);
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

  const vocabularies = (manifest.vocabularies || []).map((row, i) => ({
    ...row,
    data: composed(json(raw.vocabularies[i].file)),
  }));
  const documents = (manifest.documents || []).map((row, i) => {
    const files = raw.documents[i];
    return {
      ...row,
      data: composedDocument(json(files.file)),
      mediaBytes: files.mediaFile ? (entries[files.mediaFile] ?? null) : null,
    };
  });
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
