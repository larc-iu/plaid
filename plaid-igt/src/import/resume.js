// What every importer shares to be resumable: the two marks it leaves on a
// document, the way it finds what an earlier run made, and the error a
// cancel raises.
//
// A run can stop part way (the user cancels, a request fails, the tab is
// closed) and is picked up by running the same import over the same project.
// Each document it creates is stamped with the SOURCE's own id for it (a FLEx
// text guid, a CLDF or archive document id, an ELAN file name), and marked
// done last of all. A resume then matches by that stamp, never by name:
// several texts share a name in the wild ('Untitled' is the fallback for a
// FLEx text with no title), and a document a person made by hand under the
// same name is not this import's to delete.
//
// The stamp also names the document it was written on, as
// `<document id>:<source id>`. A document copy carries its source's metadata
// over (core rewrites a value that IS the copied document's id to the copy's,
// and leaves a string that only contains it), so a copy keeps a stamp naming
// another document and is never taken for the one the import made.
//
// A source id and a name are compared composed (`nameKey`): the server stores
// the stamp and every name composed, and a file name from macOS is not.

import { nameKey } from '@ui/lib/nameKey.js';

/** `<document id>:<source id>`, written at creation. */
const SOURCE_KEY = 'importSource';
/** Written last, so a document without it is one the run did not finish. */
const DONE_KEY = 'importDone';
/** Both marks, which are the import's own bookkeeping rather than the source's data. */
export const IMPORT_STAMP_KEYS = Object.freeze([SOURCE_KEY, DONE_KEY]);

export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled');
    this.name = 'ImportCancelled';
  }
}

/**
 * A document's metadata with the import's marks on it, for the document
 * `documentId` made from the source's `sourceId`. A done mark the source's
 * own metadata carries is dropped (a CLDF column, an ELAN property or an
 * archive may name a key `importDone`), since it would say the document was
 * finished before this import had made any of it.
 */
export const importStamp = (metadata, sourceId, documentId, done = false) => {
  const { [DONE_KEY]: _, ...rest } = metadata || {};
  return {
    ...rest,
    [SOURCE_KEY]: `${documentId}:${nameKey(sourceId)}`,
    ...(done ? { [DONE_KEY]: true } : {}),
  };
};

// The source id a document's stamp gives, or null when it has none or the
// stamp was written on another document (this one is a copy of it).
const stampedSource = (doc) => {
  const stamp = doc?.metadata?.[SOURCE_KEY];
  if (typeof stamp !== 'string') return null;
  const at = stamp.indexOf(':');
  if (at < 0 || stamp.slice(0, at) !== doc.id) return null;
  return stamp.slice(at + 1) || null;
};

/**
 * What an earlier run left in the project, keyed by source id. One read per
 * document, since the listing carries no metadata; a resume is rare and a
 * project has at most a few hundred documents.
 *
 * @returns {{find: (sourceId: string) => object|null, done: (doc: object) => boolean}}
 */
export async function priorImports(client, projectId) {
  const listed = await client.projects.listDocuments(projectId);
  const docs = await Promise.all(listed.map((d) => client.documents.get(d.id)));
  const bySource = new Map();
  for (const d of docs) {
    const source = stampedSource(d);
    if (source) bySource.set(nameKey(source), d);
  }
  const names = new Set(listed.map((d) => nameKey(d.name)));
  return {
    find: (sourceId) => bySource.get(nameKey(sourceId)) ?? null,
    done: (doc) => doc?.metadata?.[DONE_KEY] === true,
    /** Every document name in the project, composed, for naming a copy beside one. */
    names,
  };
}

/**
 * A name not yet in `taken` (composed names), made from `base` the way a file
 * manager does it: "Story (2)", then "Story (3)". Adds the result to `taken`,
 * so a run that makes several copies never hands out one name twice.
 */
export function unusedName(base, taken) {
  const composed = nameKey(base);
  let name = composed;
  for (let n = 2; taken.has(name); n += 1) name = `${composed} (${n})`;
  taken.add(name);
  return name;
}

/**
 * Whether a document the source names has to be imported: it is skipped when
 * an earlier run finished it, and redone (deleted first) when one only began
 * it. `replace` redoes a finished one too, which is what a screen asks for
 * when the person has been shown what is already there and said to import it
 * again anyway. `keepUnfinished` skips an unfinished one as well: outside a
 * resume the project is open for work, so a document a run left unfinished
 * may hold someone's work and is deleted only when the person says Replace.
 * Counts into `results`.
 */
export async function settlePrior(
  client,
  prior,
  sourceId,
  results,
  { replace = false, keepUnfinished = false } = {},
) {
  const existing = prior.find(sourceId);
  if (!existing) return true;
  if ((prior.done(existing) || keepUnfinished) && !replace) {
    results.skipped += 1;
    return false;
  }
  await client.documents.delete(existing.id); // half-imported, or being redone
  results.redone += 1;
  return true;
}
