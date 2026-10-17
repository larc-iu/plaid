import { UmrDocument } from './UmrDocument.js';
import { UnwritableUmrError } from './format/umrFile.js';

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
  const out = [];
  const problems = [];
  for (let i = 0; i < docs.length; i++) {
    const summary = docs[i];
    onProgress?.(i, docs.length, summary.name);
    const raw = await client.documents.get(summary.id, true);
    const doc = new UmrDocument({ raw, client, projectId, project });
    const found = doc.exportProblems;
    if (found.length) problems.push(...found.map((p) => ({ ...p, document: summary.name })));
    else out.push({ name: summary.name, text: doc.toUmr() });
  }
  onProgress?.(docs.length, docs.length, null);
  if (problems.length) throw new UnwritableUmrError(problems);
  return out;
}
