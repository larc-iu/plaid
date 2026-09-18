import { UmrDocument } from './UmrDocument.js';

/**
 * The official checks over every document of the project.
 * @returns {Promise<Array<{ documentId, documentName, sentenceIndex, level, code, message, var }>>}
 */
export async function validateProject(client, projectId, layerInfo, { onProgress } = {}) {
  void layerInfo;
  const docs = await client.projects.listDocuments(projectId);
  const rows = [];
  for (let i = 0; i < docs.length; i++) {
    const summary = docs[i];
    onProgress?.(i, docs.length, summary.name);
    const raw = await client.documents.get(summary.id, true);
    const doc = new UmrDocument({ raw, client, projectId });
    doc.problems.forEach((p) => {
      rows.push({
        documentId: summary.id,
        documentName: summary.name,
        sentenceIndex: p.sentence ?? null,
        level: p.level,
        code: p.code,
        message: p.message,
        var: p.var ?? null,
      });
    });
  }
  onProgress?.(docs.length, docs.length, null);
  return rows;
}
