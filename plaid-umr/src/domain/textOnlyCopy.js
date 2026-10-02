// A copy of a document with its UMR graphs left out, for a second annotator
// who starts from the words and glosses (the owner's ruling
// umr-collab-blank-copy). Core copies the whole document, and plaid-umr then
// takes its own graph back off the copy, all as one History entry. No core
// change: what goes is what UMR owns, and the text, the words and every other
// app's annotation stay.
//
// What goes:
//   - every anchor on the UMR node layer, which takes the concept spans, the
//     edges and the document-level relations with it
//   - in each sentence's record, the graph a file carried that could not be
//     read (`rawGraph`, `rawAlignment`), the relations held for it (`held`)
//     and the triples between constants its block wrote (`triples`)
//   - on each sentence token, a comparison report's row (`adjudication`)
//   - the comparison report on the document (`adjudication`), since the copy
//     was never compared
// The sentence's own record (`snt`, `text`, `ilg`, `meta`) stays: it is the
// text, not the graph.
import { getUmrLayerInfo, UMR_NAMESPACE } from '../utils/umrLayerUtils.js';
import { isRecordToken } from './sentenceGraph.js';

/** The record keys that hold graph, not text. */
const RECORD_GRAPH_KEYS = ['rawGraph', 'rawAlignment', 'held', 'triples'];

/** The sentence token keys that hold graph, not text. */
const SENTENCE_GRAPH_KEYS = ['adjudication'];

// Keeps each bulk update well inside what one request should carry.
const SENTENCE_CHUNK = 500;

// The ops deleting `keys` from a token's UMR metadata, as a bulk update's
// entry, or nothing when it holds none of them.
const without = (token, keys) => {
  const umr = token.metadata?.[UMR_NAMESPACE];
  if (!umr || typeof umr !== 'object') return [];
  const ops = keys.filter((k) => k in umr).map((k) => ({ op: 'delete', path: [UMR_NAMESPACE, k] }));
  return ops.length ? [{ id: token.id, metadata: ops }] : [];
};

/**
 * What leaving the graphs out of `raw` (a document read with its body) takes:
 * `{ nodeTokenIds, sentenceUpdates, documentOps }`, each empty when there is
 * nothing to do. `sentenceUpdates` covers the records and the sentence
 * tokens alike.
 */
export function textOnlyPlan(raw) {
  const info = getUmrLayerInfo(raw);
  const nodeTokens = info.nodeTokenLayer?.tokens || [];
  const nodeTokenIds = nodeTokens.filter((t) => !isRecordToken(t)).map((t) => t.id);
  const sentenceUpdates = [
    ...nodeTokens.filter(isRecordToken).flatMap((t) => without(t, RECORD_GRAPH_KEYS)),
    ...(info.sentenceTokenLayer?.tokens || []).flatMap((t) => without(t, SENTENCE_GRAPH_KEYS)),
  ];
  const documentOps =
    raw?.metadata?.[UMR_NAMESPACE] && 'adjudication' in raw.metadata[UMR_NAMESPACE]
      ? [{ op: 'delete', path: [UMR_NAMESPACE, 'adjudication'] }]
      : [];
  return { nodeTokenIds, sentenceUpdates, documentOps };
}

/** Take the UMR graphs off the document `documentId`, in one batch. */
export async function leaveOutGraphs(client, documentId) {
  const raw = await client.documents.get(documentId, true);
  const { nodeTokenIds, sentenceUpdates, documentOps } = textOnlyPlan(raw);
  if (!nodeTokenIds.length && !sentenceUpdates.length && !documentOps.length) return;
  await client.batched(async (b) => {
    if (nodeTokenIds.length) b.tokens.bulkDelete(nodeTokenIds);
    for (let i = 0; i < sentenceUpdates.length; i += SENTENCE_CHUNK) {
      b.tokens.bulkUpdate(sentenceUpdates.slice(i, i + SENTENCE_CHUNK));
    }
    if (documentOps.length) b.documents.patchMetadata(documentId, documentOps);
  });
}

/**
 * Copy `doc` as `name` and leave the UMR graphs out of the copy, as one
 * History entry. Resolves to `{ id, name }` for the copy, or null when the
 * copy itself failed (the screen has been told).
 *
 * A copy made whose graphs could not be taken off is the wrong document, one
 * a blind second annotator must not open, so it is deleted and the failure
 * thrown as the copy's own: a retry starts clean. Only when that delete fails
 * too does it throw `CopyKeptGraphs`, carrying the copy that is left.
 */
export async function copyTextOnly(client, doc, name) {
  const next = (name || '').trim() || `${doc.name} (copy)`;
  let created = null;
  try {
    await client.withOperation(`Copy "${doc.name}" as "${next}", text only`, async () => {
      created = await doc.copyTo(next);
      if (created?.id) await leaveOutGraphs(client, created.id);
    });
  } catch (error) {
    if (!created?.id) throw error;
    try {
      await client.documents.delete(created.id, `Delete "${created.name}"`);
    } catch {
      throw new CopyKeptGraphs(created, error);
    }
    throw error;
  }
  return created;
}

/** The copy was made, its UMR graphs could not be taken off, and it could
 * not be deleted either. */
export class CopyKeptGraphs extends Error {
  constructor(created, cause) {
    super(cause?.message || 'The UMR graphs could not be taken off the copy.');
    this.name = 'CopyKeptGraphs';
    this.created = created;
    this.cause = cause;
  }
}
