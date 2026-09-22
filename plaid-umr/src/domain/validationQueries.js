// The Validation tab's read of a whole project.
//
// The checks are the umrtools validator's and they need WHOLE GRAPHS, so
// unlike plaid-ud's tab this cannot be answered by aggregate queries: the
// documents have to be loaded. What the query does instead is say which
// documents are worth loading, and the loads then run a few at a time. On
// the thousand-document corpora the agent scale review names, reading every
// document with a body one after another was the whole cost of the tab, and
// most of those documents have no UMR annotation at all.
import { UmrDocument } from './UmrDocument.js';

// How many document reads are in flight at once. Enough to cover the round
// trip on a remote server, few enough that a scan does not monopolise the
// connection or the server's readers while somebody else is annotating.
const READERS = 4;

/**
 * The ids of the project's documents that hold at least one UMR node, from
 * one query. A document with no concept span has no graph for the checks to
 * find, and in a corpus being worked through that is most of them.
 */
export const documentsWithNodes = (projectId, conceptLayerId) => ({
  where: [['span', '?s', { layer: conceptLayerId, doc: { var: '?d' } }]],
  return: { group: ['?d'], aggregates: [['count']] },
  scope: { projectIds: [projectId] },
});

/**
 * Run `work` over `items` with at most `limit` in flight, keeping the
 * results in the order of the input.
 */
async function mapLimit(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const runner = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return out;
}

/**
 * The official checks over every document of the project.
 *
 * `onProgress(done, total, name)` is called as each document lands. With
 * several reads in flight the documents finish out of order, so `name` is
 * the one that just landed rather than the one being read.
 *
 * @returns {Promise<Array<{ documentId, documentName, sentenceIndex, level, code, message, var }>>}
 */
export async function validateProject(client, projectId, conceptLayerId, { onProgress } = {}) {
  const docs = await client.projects.listDocuments(projectId);
  let candidates = docs;
  if (conceptLayerId) {
    const answer = await client.query(documentsWithNodes(projectId, conceptLayerId));
    const annotated = new Set((answer?.results || []).map(([docId]) => String(docId)));
    candidates = docs.filter((d) => annotated.has(String(d.id)));
  }
  let done = 0;
  const perDocument = await mapLimit(candidates, READERS, async (summary) => {
    const raw = await client.documents.get(summary.id, true);
    const doc = new UmrDocument({ raw, client, projectId });
    const rows = doc.problems.map((p) => ({
      documentId: summary.id,
      documentName: summary.name,
      sentenceIndex: p.sentence ?? null,
      level: p.level,
      code: p.code,
      message: p.message,
      var: p.var ?? null,
    }));
    onProgress?.(++done, candidates.length, summary.name);
    return rows;
  });
  onProgress?.(candidates.length, candidates.length, null);
  return perDocument.flat();
}
