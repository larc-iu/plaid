// The enhanced dependency graph, as UD stores it and as CoNLL-U writes it.
//
// CoNLL-U's DEPS column states the whole enhanced graph, every edge of it,
// including the ones it shares with the basic tree. Stored that way, a
// sentence's tree would be drawn twice and the copy would go stale at the
// first re-pointed head. So the enhanced relation layer holds only what
// DIFFERS from the basic tree:
//
//   - an EXTRA edge: a relation the enhanced graph has and the tree lacks.
//   - a SUPPRESSOR: a valueless relation, `metadata.suppress === true`, laid
//     over the same head and dependent as a basic relation, saying the
//     enhanced graph leaves that one out.
//
// The enhanced graph is then the basic tree, less what is suppressed, plus the
// extras. A relabel (`nmod` in the tree, `nmod:of` in the graph) is one of
// each. A sentence with no rows at all has an enhanced graph equal to its
// tree, which is what a project that never touches this exports.
//
// Everything that writes a BASIC relation stays ignorant of all this, and that
// is the point of keeping both kinds of row in the enhanced layer. A re-pointed
// head is a delete and a create, a parser rewrites a whole tree, a Grew rule
// moves an edge: none of them has a flag to carry across. What a moved basic
// relation leaves behind is a suppressor over a pair that no longer has a
// basic relation, which is DETECTABLE, so reconcile-on-open removes it
// (`danglingSuppressorIds`). An extra edge left behind is simply still drawn.
//
// A root is a relation from a word to itself in both layers, as the basic
// tree already has it.
//
// Pure. Read by the export, the import, the tree and reconcile, so that the
// rule is written once.

export const SUPPRESS_KEY = 'suppress';

export const isSuppressor = (row) => row?.metadata?.[SUPPRESS_KEY] === true;

// Span ids are UUIDs, so a space cannot occur inside one.
const pairKey = (source, target) => `${source} ${target}`;

const suppressedPairs = (rows) => {
  const pairs = new Set();
  for (const row of rows || []) {
    if (isSuppressor(row)) pairs.add(pairKey(row.source, row.target));
  }
  return pairs;
};

/** Ids of the basic relations the enhanced graph leaves out. */
export const suppressedBasicIds = (basic, rows) => {
  const pairs = suppressedPairs(rows);
  const ids = new Set();
  for (const rel of basic || []) {
    if (pairs.has(pairKey(rel.source, rel.target))) ids.add(rel.id);
  }
  return ids;
};

/** The suppressor lying over this basic relation, if there is one. */
export const suppressorFor = (basicRelation, rows) =>
  (rows || []).find(
    (row) =>
      isSuppressor(row) &&
      row.source === basicRelation.source &&
      row.target === basicRelation.target,
  ) || null;

/**
 * Every edge of the enhanced graph: `{ id, source, target, value, origin }`,
 * where `origin` is `'basic'` for an edge the tree supplies and `'enhanced'`
 * for an extra.
 */
export const enhancedEdges = (basic, rows) => {
  const pairs = suppressedPairs(rows);
  const edges = [];
  for (const rel of basic || []) {
    if (pairs.has(pairKey(rel.source, rel.target))) continue;
    edges.push({
      id: rel.id,
      source: rel.source,
      target: rel.target,
      value: rel.value,
      origin: 'basic',
    });
  }
  for (const row of rows || []) {
    if (isSuppressor(row)) continue;
    edges.push({
      id: row.id,
      source: row.source,
      target: row.target,
      value: row.value,
      origin: 'enhanced',
    });
  }
  return edges;
};

/** The extra edges alone, which is what the tree draws over the basic arcs. */
export const extraEdges = (rows) => (rows || []).filter((row) => !isSuppressor(row));

/**
 * Suppressors that suppress nothing: the basic relation they lay over has
 * been deleted or re-pointed since. Reconcile deletes these.
 */
export const danglingSuppressorIds = (basic, rows) => {
  const basicPairs = new Set((basic || []).map((rel) => pairKey(rel.source, rel.target)));
  return (rows || [])
    .filter((row) => isSuppressor(row) && !basicPairs.has(pairKey(row.source, row.target)))
    .map((row) => row.id);
};

// ---------------------------------------------------------------------------
// The DEPS column
// ---------------------------------------------------------------------------

/**
 * One DEPS value read into `{ edges: [{ head, deprel }], emptyHeads }`, or null
 * for `_`, which states nothing. A head with a decimal id names an empty node,
 * which Plaid UD does not store: such an edge is left out and counted. A
 * relation may itself contain colons (`conj:and`, `obl:in:loc`), so only the
 * first one divides head from relation.
 */
export const parseDeps = (column) => {
  const text = (column || '').trim();
  if (!text || text === '_') return null;
  const edges = [];
  let emptyHeads = 0;
  for (const part of text.split('|')) {
    const cut = part.indexOf(':');
    if (cut <= 0) throw new Error(`Invalid DEPS value: ${part}`);
    const headText = part.slice(0, cut);
    const deprel = part.slice(cut + 1);
    if (!deprel) throw new Error(`Invalid DEPS value: ${part}`);
    if (/^\d+\.\d+$/.test(headText)) {
      emptyHeads += 1;
      continue;
    }
    if (!/^\d+$/.test(headText)) throw new Error(`Invalid DEPS value: ${part}`);
    const head = parseInt(headText, 10);
    if (!edges.some((e) => e.head === head && e.deprel === deprel)) edges.push({ head, deprel });
  }
  return { edges, emptyHeads };
};

/**
 * What one imported row adds to the enhanced layer, given its basic `head`
 * and `deprel` (null `deprel` = no basic relation) and its parsed DEPS:
 * `{ extras: [{ head, deprel }], suppress }`.
 *
 * A row whose DEPS is `_` says nothing about the graph and follows its tree.
 * So does a row whose every enhanced head was an empty node: with the empty
 * node gone, the basic `orphan` analysis is the one that still stands.
 */
export const planEnhancedRow = ({ head, deprel }, deps) => {
  if (!deps || deps.edges.length === 0) return { extras: [], suppress: false };
  const isBasic = (e) => deprel != null && e.head === head && e.deprel === deprel;
  return {
    extras: deps.edges.filter((e) => !isBasic(e)),
    suppress: deprel != null && !deps.edges.some(isBasic),
  };
};

/** `[{ head, deprel }]` as a DEPS value: by head, then by relation. */
export const serializeDeps = (edges) => {
  if (!edges || edges.length === 0) return '_';
  return [...edges]
    .sort((a, b) => a.head - b.head || (a.deprel < b.deprel ? -1 : a.deprel > b.deprel ? 1 : 0))
    .map((e) => `${e.head}:${e.deprel}`)
    .join('|');
};
