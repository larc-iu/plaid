// The Validation tab's read of a whole project.
//
// The checks are the umrtools validator's and they need WHOLE GRAPHS, so
// unlike plaid-ud's tab this cannot be answered by aggregate queries: the
// documents have to be loaded. What the queries do instead is say which
// documents are worth loading, and the loads then run a few at a time. On
// the thousand-document corpora the agent scale review names, reading every
// document with a body one after another was the whole cost of the tab.
//
// A document is worth loading when it holds a graph OR holds words. The
// second half is not optional: `checkUnalignedToken` warns about every word
// carrying no node, so a document nobody has annotated yet reports its
// sentences as graphless (`reportOf` makes that a row per sentence), and that
// report is how a corpus manager sees it is not annotated. Asking only for the graphs read clean over a corpus that had
// barely been started. A document with neither has nothing to check: every
// check walks either the nodes or the words.
import { UmrDocument } from './UmrDocument.js';
import { writtenIds } from './sentenceGraph.js';

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
 * The ids of the project's documents that hold at least one word, from one
 * query. A document with no words and no graph has nothing for any check to
 * walk; one with words and no graph is an unannotated document, which the
 * report names sentence by sentence.
 */
export const documentsWithWords = (projectId, wordLayerId) => ({
  where: [['token', '?t', { layer: wordLayerId, doc: { var: '?d' } }]],
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
 * One document's rows, in sentence order (the checks that walk the whole
 * graph report after the per-sentence ones), with a document-level problem
 * first.
 *
 * Two kinds of the validator's `unaligned-token` warning are folded, since a
 * sentence being worked through would otherwise bury every other problem
 * under a row per word:
 * - a sentence with no graph at all gets ONE row for its words, counted;
 * - a word that IS aligned, to a node the root does not reach, gets none. The
 *   export leaves that node out, which is why the validator sees the word
 *   bare, and the node's `unreached-by-root` row already says so.
 */
export function reportOf(doc) {
  const graphless = new Set();
  // 1-based word numbers with a node the export leaves out on them, by
  // sentence. Only those: a word the export does write a node for and the
  // validator still calls bare is a real fault, and keeps its row.
  const alignedWords = new Map();
  (doc.sentences || []).forEach((s) => {
    if (!s.nodes?.length) graphless.add(s.index);
    const written = writtenIds(s, doc.graph.nodesById);
    const ids = new Set(
      (s.nodes || []).filter((n) => !written.has(n.id)).flatMap((n) => n.wordIds || []),
    );
    alignedWords.set(
      s.index,
      new Set((s.words || []).flatMap((w, i) => (ids.has(w.id) ? [i + 1] : []))),
    );
  });
  // The one row of each graphless sentence, and how many words it stands for.
  const collapsed = new Map();
  const rows = [];
  doc.problems.forEach((p) => {
    if (p.code !== 'unaligned-token') {
      rows.push(p);
      return;
    }
    if (alignedWords.get(p.sentence)?.has(p.word)) return;
    if (!graphless.has(p.sentence)) {
      rows.push(p);
      return;
    }
    const row = collapsed.get(p.sentence);
    if (row) row.count += 1;
    else {
      const first = { problem: p, count: 1 };
      collapsed.set(p.sentence, first);
      rows.push(first);
    }
  });
  return rows
    .map((row) =>
      row.problem
        ? {
            ...row.problem,
            message: `No graph. ${row.count} ${
              row.count === 1 ? 'word is' : 'words are'
            } not aligned to any node.`,
          }
        : row,
    )
    .map((p, i) => [p, i])
    .sort(([a, ai], [b, bi]) => (a.sentence ?? 0) - (b.sentence ?? 0) || ai - bi)
    .map(([p]) => p);
}

/**
 * The official checks over every document of the project.
 *
 * `conceptLayerId` and `wordLayerId` are what the scan asks the server about
 * before it reads anything; without both it reads every document, as it did
 * before there were queries to narrow it.
 *
 * `onProgress(done, total, name)` is called as each document lands. With
 * several reads in flight the documents finish out of order, so `name` is
 * the one that just landed rather than the one being read.
 *
 * @returns {Promise<Array<{ documentId, documentName, sentenceIndex, level, code, message, var }>>}
 */
export async function validateProject(
  client,
  projectId,
  { conceptLayerId = null, wordLayerId = null, onProgress } = {},
) {
  const docs = await client.projects.listDocuments(projectId);
  let candidates = docs;
  if (conceptLayerId && wordLayerId) {
    const [nodes, words] = await Promise.all([
      client.query(documentsWithNodes(projectId, conceptLayerId)),
      client.query(documentsWithWords(projectId, wordLayerId)),
    ]);
    const worthReading = new Set(
      [...(nodes?.results || []), ...(words?.results || [])].map(([docId]) => String(docId)),
    );
    candidates = docs.filter((d) => worthReading.has(String(d.id)));
  }
  let done = 0;
  const perDocument = await mapLimit(candidates, READERS, async (summary) => {
    const raw = await client.documents.get(summary.id, true);
    const doc = new UmrDocument({ raw, client, projectId });
    const rows = reportOf(doc).map((p) => ({
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
