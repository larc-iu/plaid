// The mark an ELAN import leaves on each document it makes, and the error a
// cancel raises in every importer.
//
// "Add ELAN documents" imports .eaf files into a project that is open for
// work, and names on its screen the files an earlier import already brought
// in, with the choice of keeping, replacing or copying each. It finds them by
// the mark: the .eaf file name, written on the document at creation. A name
// alone would not do, since a document a person made under the same name is
// not this import's to replace.
//
// The mark also names the document it was written on, as
// `<document id>:<source id>`. A document copy carries its source's metadata
// over (core rewrites a value that IS the copied document's id to the copy's,
// and leaves a string that only contains it), so a copy keeps a mark naming
// another document and is never taken for the one the import made.
//
// A source id and a name are compared composed (`nameKey`): the server stores
// the mark and every name composed, and a file name from macOS is not.

import { nameKey } from '@ui/lib/nameKey.js';

/** `<document id>:<source id>`, written at creation. */
const SOURCE_KEY = 'importSource';
/**
 * The import's own bookkeeping rather than the source's data, which the
 * archive export leaves out: the mark, and the done mark imports used to write.
 */
export const IMPORT_STAMP_KEYS = Object.freeze([SOURCE_KEY, 'importDone']);

/** A document's metadata less the import's marks, for a copy. */
export const withoutStamps = (metadata) =>
  Object.fromEntries(
    Object.entries(metadata || {}).filter(([k]) => !IMPORT_STAMP_KEYS.includes(k)),
  );

export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled');
    this.name = 'ImportCancelled';
  }
}

/**
 * A document's metadata with the import's mark on it, for the document
 * `documentId` made from the source's `sourceId`.
 */
export const importStamp = (metadata, sourceId, documentId) => ({
  ...withoutStamps(metadata),
  [SOURCE_KEY]: `${documentId}:${nameKey(sourceId)}`,
});

// The source id a document's mark gives, or null when it has none or the
// mark was written on another document (this one is a copy of it).
const stampedSource = (doc) => {
  const stamp = doc?.metadata?.[SOURCE_KEY];
  if (typeof stamp !== 'string') return null;
  const at = stamp.indexOf(':');
  if (at < 0 || stamp.slice(0, at) !== doc.id) return null;
  return stamp.slice(at + 1) || null;
};

/**
 * What an earlier import left in the project, keyed by source id. One read
 * per document, since the listing carries no metadata.
 *
 * @returns {{find: (sourceId: string) => object|null}}
 */
export async function priorImports(client, projectId) {
  const listed = await client.projects.listDocuments(projectId);
  const docs = await Promise.all(listed.map((d) => client.documents.get(d.id)));
  const bySource = new Map();
  for (const d of docs) {
    const source = stampedSource(d);
    if (source) bySource.set(nameKey(source), d);
  }
  return { find: (sourceId) => bySource.get(nameKey(sourceId)) ?? null };
}

/**
 * Whether a document the source names has to be imported: one an earlier
 * import made is kept (counted `skipped`), or deleted first and made again
 * when `replace` says so (counted `redone`).
 */
export async function settlePrior(client, prior, sourceId, results, { replace = false } = {}) {
  const existing = prior.find(sourceId);
  if (!existing) return true;
  if (!replace) {
    results.skipped += 1;
    return false;
  }
  await client.documents.delete(existing.id);
  results.redone += 1;
  return true;
}
