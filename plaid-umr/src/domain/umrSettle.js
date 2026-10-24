// What the next UMR write to a sentence stores of what the reader shows
// there and the stored rows do not say yet (Luke's ruling R3, 2026-10-24:
// opening a document writes nothing).
//
// Another app's edit to the shared sentences leaves UMR's rows saying less
// than the reader reads off them (sentenceGraph.js): a node aligned to no
// word whose sentence token is gone, whose anchor reaches out of its
// sentence, or whose word was deleted; a variable whose sentence number
// moved; a record left on new text or narrower than its share; a node over a
// word split in two. The reader gives the answer every time, and nobody's opening the
// page writes it. The first UMR write that touches a sentence stores what
// the reader shows there, unstamped (it decides nothing and vouches for
// nothing), sent before the write's own requests under the same operation,
// and every variable the reader renames in the document with it.
// A node outside every sentence is read as not there and is left stored,
// since no write can touch it.
//
// By their real paths rather than through `@ui`: the node suite has no alias.
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { isPendingId, settledId } from '../../../plaid-ui/src/domain/pendingIds.js';
import { UMR_NAMESPACE } from '../utils/umrLayerUtils.js';
import { recordShares, unalignedStretch } from './sentenceGraph.js';

const umrOf = (node) => node?.metadata?.[UMR_NAMESPACE] || {};

/**
 * The metadata ops that write each key of `changes` into the `umr`
 * namespace, an undefined value deleting its key. The namespace's other keys
 * stay as they are.
 */
export const umrOps = (changes) =>
  Object.entries(changes).map(([k, v]) =>
    v === undefined
      ? { op: 'delete', path: [UMR_NAMESPACE, k] }
      : { op: 'set', path: [UMR_NAMESPACE, k], value: v },
  );

/**
 * What storing the reader's answer for the sentences `indexes` (1-based, of
 * `graph`, a Set, or null for all) writes, or null when it writes nothing:
 * `{ meta, updates, retoken, held }` where `meta` maps a node id to the
 * changes to its namespace (an undefined value deletes the key), `updates`
 * lists token extents to write (`{ id, begin, end }`), `retoken` lists nodes
 * whose extra anchor pieces go (`{ nodeId, tokens, drop }`), and `held`
 * lists the records whose held relations take renamed variables
 * (`[recordId, held]`). Rows not yet made on the server (pending ids) are
 * left for a later write.
 *
 * The variables the reader renames (renumberMoves) are stored for the whole
 * document at once, with every record's held relations as the reader reads
 * them, whatever `indexes` says: a held relation goes by name, and a name
 * stored in one sentence and not yet in another reads as another node's.
 *
 * An entry link is never deleted here. A link to an entry the lexicon lacks
 * reads as none in every reader, and the lexicon may be older than the link.
 */
export function planSettle(graph, indexes) {
  const meta = new Map();
  const updates = [];
  const retoken = [];
  const change = (id, changes) => meta.set(id, { ...meta.get(id), ...changes });
  graph.sentences.forEach((s) => {
    if (indexes && !indexes.has(s.index)) return;
    s.nodes.forEach((node) => {
      if (node.constant || isPendingId(node.id)) return;
      const own = umrOf(node);
      // A node aligned to no word: it records the sentence it stands in, and
      // stands over one stretch of it.
      const lostWord =
        !own.sentence &&
        !node.aligned &&
        node.pieces.some((p) => p.end > p.begin) &&
        s.words.length > 0;
      if (own.sentence || lostWord) {
        if (own.sentence !== s.tokenId) change(node.id, { sentence: s.tokenId });
        if (lostWord && own.words) change(node.id, { words: undefined });
        const [piece, ...rest] = node.pieces;
        if (piece && !isPendingId(piece.id)) {
          const { begin, end } = unalignedStretch(node.pieces, s);
          if (piece.begin !== begin || piece.end !== end)
            updates.push({ id: piece.id, begin, end });
          if (rest.length) {
            retoken.push({
              nodeId: node.id,
              tokens: [piece.id, ...node.holdIds],
              drop: rest.map((p) => p.id),
            });
          }
        }
      }
      // On one half of a word split in two.
      if (node.cuts?.length) {
        node.cuts.forEach(({ pieceId, begin, end }) => {
          if (!isPendingId(pieceId)) updates.push({ id: pieceId, begin, end });
        });
        change(node.id, { words: node.wordIds });
      }
    });
  });
  recordShares(graph, indexes).forEach(({ id, begin, end }) => {
    if (!isPendingId(id)) updates.push({ id, begin, end });
  });
  // Every variable read under another name than it stores, and the held
  // relations of every record as they read under those names.
  const held = [];
  let renames = false;
  graph.nodesById.forEach((node) => {
    if (node.constant || isPendingId(node.id) || !node.var || node.storedVar === node.var) return;
    change(node.id, { var: node.var });
    renames = true;
  });
  if (renames) {
    (graph.records || []).forEach(({ id, record, held: read }) => {
      if (isPendingId(id)) return;
      const had = Array.isArray(record.held) ? record.held : [];
      if (!had.length) return;
      if (read.some((h, i) => h.source !== had[i].source || h.target !== had[i].target)) {
        held.push([id, read.map((h) => ({ ...h }))]);
      }
    });
  }
  if (!meta.size && !updates.length && !retoken.length && !held.length) return null;
  return { meta, updates, retoken, held };
}

/**
 * `plan` (planSettle) applied to the layers `L` of a document copy:
 * `{ tokens, spans }` of the node layer, as UmrDocument's `_layers` gives
 * them.
 */
export function applySettle(L, plan) {
  const apply = (metadata, changes) => applyMetadataOps(metadata, umrOps(changes));
  const tokens = new Map(L.tokens.map((t) => [t.id, t]));
  plan.updates.forEach(({ id, begin, end }) => {
    const t = tokens.get(id);
    if (t) Object.assign(t, { begin, end });
  });
  plan.held.forEach(([id, held]) => {
    const t = tokens.get(id);
    if (t) t.metadata = apply(t.metadata, { held });
  });
  const spans = new Map(L.spans.map((s) => [s.id, s]));
  plan.meta.forEach((changes, id) => {
    const s = spans.get(id);
    if (s) s.metadata = apply(s.metadata, changes);
  });
  const dropped = new Set();
  plan.retoken.forEach(({ nodeId, tokens: kept, drop }) => {
    const s = spans.get(nodeId);
    if (s) s.tokens = [...kept];
    drop.forEach((id) => dropped.add(id));
  });
  if (dropped.size) {
    for (let i = L.tokens.length - 1; i >= 0; i--)
      if (dropped.has(L.tokens[i].id)) L.tokens.splice(i, 1);
  }
}

/** `plan` (planSettle) queued on batch `b`. */
export function queueSettle(b, plan) {
  const ops = umrOps;
  plan.updates.forEach(({ id, begin, end }) => b.tokens.update(settledId(id), begin, end));
  plan.held.forEach(([id, held]) => b.tokens.patchMetadata(settledId(id), ops({ held })));
  plan.meta.forEach((changes, id) => b.spans.patchMetadata(settledId(id), ops(changes)));
  plan.retoken.forEach(({ nodeId, tokens, drop }) => {
    b.spans.setTokens(settledId(nodeId), tokens.map(settledId));
    b.tokens.bulkDelete(drop.map(settledId));
  });
}
