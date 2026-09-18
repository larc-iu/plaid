import { UmrDocument } from './UmrDocument.js';

const sanitize = (name) => String(name || 'document').replace(/[\\/:*?"<>|]+/g, '_');

/**
 * Every document of the project as a .umr file.
 * @returns {Promise<Array<{ name: string, text: string }>>}
 */
export async function exportProjectUmr(client, projectId, layerInfo, { onProgress } = {}) {
  void layerInfo;
  const docs = await client.projects.listDocuments(projectId);
  const out = [];
  const used = new Set();
  for (let i = 0; i < docs.length; i++) {
    const summary = docs[i];
    onProgress?.(i, docs.length, summary.name);
    const raw = await client.documents.get(summary.id, true);
    const doc = new UmrDocument({ raw, client, projectId });
    let name = `${sanitize(summary.name)}.umr`;
    let n = 2;
    while (used.has(name)) name = `${sanitize(summary.name)} (${n++}).umr`;
    used.add(name);
    out.push({ name, text: doc.toUmr() });
  }
  onProgress?.(docs.length, docs.length, null);
  return out;
}
