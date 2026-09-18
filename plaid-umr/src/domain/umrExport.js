import { UmrDocument } from './UmrDocument.js';

/**
 * Every document of the project as a .umr file. Names are the documents' own;
 * the caller adds the extension and settles duplicates.
 * @returns {Promise<Array<{ name: string, text: string }>>}
 */
export async function exportProjectUmr(client, projectId, layerInfo, { onProgress } = {}) {
  void layerInfo;
  const docs = await client.projects.listDocuments(projectId);
  const out = [];
  for (let i = 0; i < docs.length; i++) {
    const summary = docs[i];
    onProgress?.(i, docs.length, summary.name);
    const raw = await client.documents.get(summary.id, true);
    const doc = new UmrDocument({ raw, client, projectId });
    out.push({ name: summary.name, text: doc.toUmr() });
  }
  onProgress?.(docs.length, docs.length, null);
  return out;
}
