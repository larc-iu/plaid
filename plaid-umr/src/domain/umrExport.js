import { UmrDocument, readEntryLexicon } from './UmrDocument.js';
import { UnwritableUmrError } from './format/umrFile.js';
// By real path, so the node suite loads it (no `@ui` alias there).
import { readInOrder } from '../../../plaid-ui/src/lib/documentReads.js';

/**
 * Every document of the project as a .umr file, each with the gloss lines the
 * project's settings name, as its Export tab writes it. Names are the documents' own;
 * the caller adds the extension and settles duplicates. Throws
 * UnwritableUmrError, listing every document's problems at once, when any
 * document holds a value the file cannot (see UmrDocument.exportProblems).
 * @returns {Promise<Array<{ name: string, text: string }>>}
 */
export async function exportProjectUmr(client, projectId, project, { onProgress } = {}) {
  const docs = await client.projects.listDocuments(projectId);
  // The vocabularies, for the type each linked morpheme goes by, which sets
  // the joints of the gloss lines.
  const lexicon = docs.length ? ((await readEntryLexicon(client, project))?.lexicon ?? null) : null;
  const out = [];
  const problems = [];
  // One read at a time, the next sent while this one is written out.
  const reads = readInOrder(
    docs.map((_, i) => i),
    (i) => {
      onProgress?.(i, docs.length, docs[i].name);
      return client.documents.get(docs[i].id, true);
    },
    { inFlight: 1 },
  );
  for await (const { id: i, value: raw, error } of reads) {
    if (error) throw error;
    const summary = docs[i];
    const doc = new UmrDocument({ raw, client, projectId, project, lexicon });
    const found = doc.exportProblems;
    if (found.length) problems.push(...found.map((p) => ({ ...p, document: summary.name })));
    else out.push({ name: summary.name, text: doc.toUmr() });
  }
  onProgress?.(docs.length, docs.length, null);
  if (problems.length) throw new UnwritableUmrError(problems);
  return out;
}
