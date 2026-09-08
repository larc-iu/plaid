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

/** The source's own id for the document, written at creation. */
export const SOURCE_KEY = 'importSource';
/** Written last, so a document without it is one the run did not finish. */
export const DONE_KEY = 'importDone';

export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled');
    this.name = 'ImportCancelled';
  }
}

/** A document's metadata with the import's marks on it. */
export const importStamp = (metadata, sourceId, done = false) => ({
  ...(metadata || {}),
  [SOURCE_KEY]: String(sourceId),
  ...(done ? { [DONE_KEY]: true } : {}),
});

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
    const source = d?.metadata?.[SOURCE_KEY];
    if (typeof source === 'string' && source) bySource.set(source, d);
  }
  return {
    find: (sourceId) => bySource.get(String(sourceId)) ?? null,
    done: (doc) => doc?.metadata?.[DONE_KEY] === true,
  };
}

/**
 * Whether a document the source names has to be imported: it is skipped when
 * an earlier run finished it, and redone (deleted first) when one only began
 * it. Counts into `results`.
 */
export async function settlePrior(client, prior, sourceId, results) {
  const existing = prior.find(sourceId);
  if (!existing) return true;
  if (prior.done(existing)) {
    results.skipped += 1;
    return false;
  }
  await client.documents.delete(existing.id); // half-imported: redo cleanly
  results.redone += 1;
  return true;
}
