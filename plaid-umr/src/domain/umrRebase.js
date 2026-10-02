// When a UMR edit refused because the document moved on goes again by itself
// (Luke's ruling, 2026-10-03): UMR conflicts are per sentence. An edit
// conflicts only with a change made meanwhile to the graph of a sentence it
// writes (its nodes, edges, triples and record), and goes again on the fresh
// document otherwise. Two people annotating different sentences of one
// document no longer refuse each other.
//
// What changed in UMR's own layers (the node layer's anchors and records,
// the nodes, the edges, the triples) is judged here, each row by the
// sentences it belongs to. Everything else (another app's layers, the text,
// a layer's own settings) is left to plaid-ui's rule by layer (rebase.js
// `apart`), as before. Each write's own `recheck` (DocumentModel) still runs
// on top: a variable another sentence took meanwhile, an end that went.
//
// A row's sentences, read off the graph as the canvas reads it, in the
// document before and after (a node moved between sentences belongs to
// both):
// - a node: its sentence. A constant (`author`, `root`) is no sentence's,
//   and is judged by its name, so two people making the same constant at
//   once conflict and the document never gets two.
// - an edge: its two ends' sentences.
// - a triple: the sentences of its ends that are nodes (two people hanging
//   triples on `author` from two sentences do not conflict), and for a
//   triple between two constants, the sentences whose block writes it.
// - an anchor piece: the sentences of the nodes standing on it, and with
//   none, the sentence it begins in.
// - a record: the sentence it is read with.
// A row that belongs to no sentence and is no constant conflicts with every
// edit, and an edit that writes such a row gets the rule by layer.
//
// By their real paths rather than through `@ui`: the node suite has no alias.
import { apart } from '../../../plaid-ui/src/domain/rebase.js';
import { isPendingId, settledId } from '../../../plaid-ui/src/domain/pendingIds.js';
import { buildDocumentGraph, isRecordToken } from './sentenceGraph.js';
import { getUmrLayerInfo } from '../utils/umrLayerUtils.js';

const beginsIn = (piece, range) => piece.begin >= range.begin && piece.begin < range.end;

// A row as text that does not depend on how it was shaped: keys in order, a
// null field the same as none, pending ids as the server's (as rebase.js
// reads entities).
const canonical = (key, value) => {
  if (typeof value === 'string') return settledId(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const k of Object.keys(value).sort()) if (value[k] != null) out[k] = value[k];
  return out;
};

const read = new WeakMap();

/**
 * UMR's rows of a raw document, each with the sentences it belongs to:
 * `{ rows: Map<id, { content, scopes: Set<string> | null, names: string[] }> }`.
 * A scope is `s:<sentence token id>` or `c:<constant name>`. Cached per raw
 * document, which is never changed once read.
 */
function umrRows(raw) {
  if (raw && typeof raw === 'object' && read.has(raw)) return read.get(raw);
  const info = getUmrLayerInfo(raw);
  const graph = buildDocumentGraph(info);
  const sentenceKey = (index) => {
    const s = index != null ? graph.sentences[index - 1] : null;
    return s ? `s:${settledId(s.tokenId)}` : null;
  };
  const nodeScope = (id) => {
    const node = graph.nodesById.get(id);
    if (!node) return null;
    if (node.constant) return node.var ? `c:${node.var}` : null;
    return sentenceKey(node.sentence);
  };
  const rows = new Map();
  const add = (row, scopes) => {
    const names = [];
    for (const k of ['source', 'target']) if (typeof row[k] === 'string') names.push(row[k]);
    if (Array.isArray(row.tokens)) names.push(...row.tokens);
    rows.set(settledId(row.id), {
      content: JSON.stringify(row, canonical),
      scopes: scopes.size ? scopes : null,
      names: names.map(settledId),
    });
  };
  const spans = info.conceptLayer?.spans || [];
  // The nodes standing on each anchor piece.
  const standing = new Map();
  spans.forEach((span) =>
    (span.tokens || []).forEach((t) => {
      if (!standing.has(t)) standing.set(t, []);
      standing.get(t).push(span.id);
    }),
  );
  const recordSentence = new Map(graph.records.map((r) => [r.id, r.sentence]));
  (info.nodeTokenLayer?.tokens || []).forEach((token) => {
    const scopes = new Set();
    if (isRecordToken(token)) {
      const key = sentenceKey(recordSentence.get(token.id));
      if (key) scopes.add(key);
    } else if (standing.has(token.id)) {
      standing.get(token.id).forEach((id) => {
        const key = nodeScope(id);
        if (key) scopes.add(key);
      });
    } else {
      const s = graph.sentences.find((x) => beginsIn(token, x));
      if (s) scopes.add(sentenceKey(s.index));
    }
    add(token, scopes);
  });
  spans.forEach((span) => {
    const key = nodeScope(span.id);
    add(span, new Set(key ? [key] : []));
  });
  (info.relationLayer?.relations || []).forEach((rel) => {
    const scopes = new Set([nodeScope(rel.source), nodeScope(rel.target)].filter(Boolean));
    add(rel, scopes);
  });
  // The sentences whose block writes each triple (sentenceGraph.js): the
  // later of its ends' sentences, or for two constants, the sentences that
  // list it.
  const blocks = new Map();
  graph.sentences.forEach((s) =>
    s.triples.forEach((t) => {
      if (!blocks.has(t.id)) blocks.set(t.id, new Set());
      blocks.get(t.id).add(sentenceKey(s.index));
    }),
  );
  (info.documentGraphLayer?.relations || []).forEach((rel) => {
    const scopes = new Set();
    for (const end of [rel.source, rel.target]) {
      const key = nodeScope(end);
      if (key?.startsWith('s:')) scopes.add(key);
    }
    if (!scopes.size) (blocks.get(rel.id) || []).forEach((key) => scopes.add(key));
    add(rel, scopes);
  });
  const out = { rows };
  if (raw && typeof raw === 'object') read.set(raw, out);
  return out;
}

// The ids of the rows that are new, gone or different between two reads.
function changedRows(a, b) {
  const out = new Set();
  for (const [id, row] of a.rows) if (b.rows.get(id)?.content !== row.content) out.add(id);
  for (const id of b.rows.keys()) if (!a.rows.has(id)) out.add(id);
  return out;
}

// Every sentence (or constant) the rows `ids` belong to in either read, or
// null when one of them belongs to none.
function scopesOf(ids, a, b) {
  const scopes = new Set();
  for (const id of ids) {
    const rows = [a.rows.get(id), b.rows.get(id)].filter(Boolean);
    if (!rows.length || rows.some((r) => !r.scopes)) return null;
    rows.forEach((r) => r.scopes.forEach((s) => scopes.add(s)));
  }
  return scopes;
}

/**
 * The sentences (and constants) a UMR edit writes, from the document it was
 * made on and the one it made. Null when it writes no UMR row, or one that
 * belongs to no sentence: such an edit gets the rule by layer.
 */
export function editScopes(base, made) {
  const a = umrRows(base);
  const b = umrRows(made);
  const changed = changedRows(a, b);
  if (!changed.size) return null;
  return scopesOf(changed, a, b);
}

/**
 * Whether an edit that writes `scopes` (editScopes) and `footprint`
 * (rebase.js footprintOf) can go again by itself on `now`, the document read
 * after its refusal, having been checked against `before`. No UMR row that
 * changed in between may belong to a sentence it writes, be a row it names
 * or removes, or name a row it removes. The rest of what changed is judged
 * by the rule by layer.
 */
export function resendableBySentence(footprint, scopes, before, now) {
  if (!footprint || !scopes) return false;
  const a = umrRows(before);
  const b = umrRows(now);
  const skip = new Set();
  for (const id of changedRows(a, b)) {
    // A row this page made that the server has not answered for is its
    // own, not a change made elsewhere (as `apart` reads it).
    if (isPendingId(id)) continue;
    if (footprint.names.has(id) || footprint.removed.has(id)) return false;
    const rows = [a.rows.get(id), b.rows.get(id)].filter(Boolean);
    if (rows.some((r) => r.names.some((n) => footprint.removed.has(n)))) return false;
    const theirs = scopesOf([id], a, b);
    if (!theirs) return false;
    for (const s of theirs) if (scopes.has(s)) return false;
    skip.add(id);
  }
  return apart(footprint, before, now, { skip });
}
