// A sentence as a small mutable graph: what the local matcher reads and the
// rewriting commands change. Built from one row of `ConlluDocument.sentences`,
// so node ids are syntactic-word token ids and edge ids are relation ids, and
// every node remembers the span ids behind its features (the address book
// diff.js needs to turn a changed graph back into writes).
//
// Grew features map onto the UD columns the way the search compiler maps them
// (compile.js): `form`, `lemma`, `upos`, `xpos` are the column features (case-
// insensitive names), anything else is a FEATS key.
//
// The root is modelled as Grew models it: an anchor node at position 0 whose
// only feature is `form=__0__`, and a `root` edge from the anchor to the root
// word. The UD import stores that edge as a self-loop on the root word; the
// conversion happens here on the way in and in diff.js on the way out. So
// `X []` matches the anchor (as in Grew), `X [upos]` does not, and `shift`
// needs no special case for the root.

const COLUMNS = { form: 'form', lemma: 'lemma', upos: 'upos', xpos: 'xpos' };

export const ANCHOR = '__0__';

// The column a Grew feature name addresses, or null for a FEATS key.
export const columnOf = (name) => COLUMNS[String(name).toLowerCase()] || null;

const emptyNode = (id, pos) => ({
  id,
  pos,
  form: '',
  lemma: undefined,
  upos: undefined,
  xpos: undefined,
  feats: new Map(),
  spanIds: { form: null, lemma: null, upos: null, xpos: null, features: new Map() },
  spanMeta: { form: null, lemma: null, upos: null, xpos: null, features: new Map() },
  substring: '',
  wordId: null,
  wordHasMultiple: false,
  anchor: false,
  deleted: false,
});

export function graphFromSentence(row) {
  const nodes = new Map();
  const order = [ANCHOR];
  nodes.set(ANCHOR, { ...emptyNode(ANCHOR, 0), form: ANCHOR, anchor: true });
  for (const entry of row.tokens) {
    const id = entry.token.id;
    const n = emptyNode(id, order.length);
    for (const f of entry.feats) {
      const eq = String(f.value).indexOf('=');
      const key = eq === -1 ? String(f.value) : String(f.value).slice(0, eq);
      const val = eq === -1 ? '' : String(f.value).slice(eq + 1);
      n.feats.set(key, val);
      n.spanIds.features.set(key, f.id);
      n.spanMeta.features.set(key, f.metadata || null);
    }
    n.form = entry.tokenForm ?? '';
    n.lemma = entry.lemma?.value ?? undefined;
    n.upos = entry.upos?.value ?? undefined;
    n.xpos = entry.xpos?.value ?? undefined;
    // Where each current value lives on the server (null = no span yet).
    for (const col of ['form', 'lemma', 'upos', 'xpos']) {
      n.spanIds[col] = entry[col]?.id || null;
      n.spanMeta[col] = entry[col]?.metadata || null;
    }
    n.substring = entry.word ? entry.wordForm : entry.tokenForm;
    n.wordId = entry.word?.id || null;
    n.wordHasMultiple = !!entry.wordHasMultipleMorphemes;
    nodes.set(id, n);
    order.push(id);
  }

  // Relations are anchored on lemma spans; resolve them to node ids. A
  // self-loop is the import's root: an edge from the anchor here.
  const nodeByLemmaSpan = new Map();
  for (const n of nodes.values()) if (n.spanIds.lemma) nodeByLemmaSpan.set(n.spanIds.lemma, n.id);
  const edges = new Map();
  for (const rel of row.relations) {
    const src = nodeByLemmaSpan.get(rel.source);
    const tgt = nodeByLemmaSpan.get(rel.target);
    if (!src || !tgt) continue; // an inter-sentential or dangling relation
    edges.set(rel.id, {
      id: rel.id,
      src: src === tgt ? ANCHOR : src,
      tgt,
      label: rel.value ?? '',
      metadata: rel.metadata || null,
    });
  }

  return {
    sentence: {
      id: row.id,
      text: row.text,
      metadata: row.sentenceToken?.metadata || {},
    },
    nodes,
    order,
    edges,
    nextId: 1,
  };
}

// A deep copy the commands can change while the original stays for the diff.
export function cloneGraph(g) {
  const nodes = new Map();
  for (const n of g.nodes.values()) {
    nodes.set(n.id, {
      ...n,
      feats: new Map(n.feats),
      spanIds: { ...n.spanIds, features: new Map(n.spanIds.features) },
      spanMeta: { ...n.spanMeta, features: new Map(n.spanMeta.features) },
    });
  }
  const edges = new Map();
  for (const e of g.edges.values()) edges.set(e.id, { ...e });
  return { sentence: g.sentence, nodes, order: [...g.order], edges, nextId: g.nextId };
}

// Live nodes in linear order, the anchor first.
export const liveNodes = (g) => g.order.map((id) => g.nodes.get(id)).filter((n) => !n.deleted);

// Live words: the nodes that are tokens.
export const liveWords = (g) => liveNodes(g).filter((n) => !n.anchor);

// Edges between words: the dependency structure without the anchor's root edge.
export const structureEdges = (g) =>
  [...g.edges.values()].filter((e) => e.src !== ANCHOR && e.src !== e.tgt);

export function getFeat(node, name) {
  const col = columnOf(name);
  if (col) return node[col];
  return node.feats.get(String(name));
}

export function setFeat(node, name, value) {
  const col = columnOf(name);
  if (col) node[col] = value;
  else node.feats.set(String(name), value);
}

export function delFeat(node, name) {
  const col = columnOf(name);
  if (col) node[col] = undefined;
  else node.feats.delete(String(name));
}

// Edges in a stable order: by source position, target position, then id.
export function sortedEdges(g) {
  const pos = (id) => g.nodes.get(id)?.pos ?? 0;
  return [...g.edges.values()].sort(
    (a, b) =>
      pos(a.src) - pos(b.src) ||
      pos(a.tgt) - pos(b.tgt) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

export const outEdges = (g, id) => sortedEdges(g).filter((e) => e.src === id);
export const inEdges = (g, id) => sortedEdges(g).filter((e) => e.tgt === id);

// A new edge id for an edge the commands add (never a server id).
export function freshEdgeId(g) {
  return `new-${g.nextId++}`;
}

// The UD deprel split the way Grew sees an edge label: `nsubj:pass` is
// `1=nsubj, 2=pass`. Returns ['nsubj', 'pass'].
export const labelParts = (label) => (label === '' ? [] : String(label).split(':'));
export const joinLabel = (parts) => parts.filter((p) => p != null && p !== '').join(':');
